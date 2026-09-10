/**
 * Wiring between a session's three websockets.
 *
 * A `Session` owns the two upstream legs (GPT-Live, media server) and the
 * single browser socket, and implements the sink the bridge emits into: audio
 * goes to the media server; transcripts and tool calls go to the browser.
 *
 * It also owns the poker simulator: every tool call lands here, moves the
 * game, and the resulting table state goes to the browser as a `ui` message
 * and back to the model as the tool result. The game is server truth — the
 * model never supplies cards, pots, or outcomes.
 *
 * Note what does NOT go to the browser: avatar audio. It reaches the browser
 * through LiveKit, because this server threads it into the media server
 * directly.
 */

import type WebSocket from "ws";
import type { ServerMessage, Turn } from "../../shared/messages";
import { inferToolName } from "../../shared/tools";
import { GptLiveBridge, type GptLiveEvents } from "./gptlive";
import { MediaServerLeg } from "./mediaServer";
import { PokerGame, type ActionOutcome } from "./poker";
import { DEAL_FALLBACK_PROMPT, SILENCE_CHECKIN } from "./prompts";
import { parsePlayerAction, tableUi } from "./tools";

// How long GPT-Live waits for the media socket before the session is written
// off. The gate is load-bearing: the bridge triggers the opening greeting as
// soon as GPT-Live reports session.started, and audio that arrives before the
// media socket exists is dropped outright — the greeting would be lost.
const MEDIA_READY_TIMEOUT_MS = 15_000;

// ── Barge-in constants ───────────────────────────────────────────────────────
// Not every user turn is an interruption: a "mm-hmm" over the avatar is a
// backchannel, and the model talks through it. Acting on the turn alone cut
// the avatar off mid-sentence — and because GPT-Live believes it already said
// the rest, it never came back. What separates the two is what the model does
// next, so a user turn only starts a watch; the timings below decide.

// How long to watch before deciding. GPT-Live yields on its own when genuinely
// interrupted (measured around 420ms), so this is long enough to see it.
const YIELD_GRACE_MS = 600;
// No audio for this long means the model stopped producing — the only state
// where clearing the buffer is right: what is queued downstream is then speech
// the model has already abandoned.
const YIELD_QUIET_MS = 350;
// Past this there is nothing left playing; clearing would be a wasted trip.
const YIELD_STALE_MS = 6_000;
// Floor between interrupts, so a re-projected turn cannot chop the avatar twice.
const INTERRUPT_COOLDOWN_MS = 1_000;

// ── Deal fallback ────────────────────────────────────────────────────────────
// The live model delegates reliably on explicit requests, but "yes" after
// "ready for another hand?" is marginal. When the user sounds like they asked
// for a hand and none is live, arm a timer: if no deal_next_hand delegation
// lands in time, the server deals directly and prompts the model to read the
// hand out. Insurance, not the plan — the game must not depend on obedience.
const DEAL_DELEGATION_TIMEOUT_MS = 8_000;
// Matched against finished user turns ONLY while no hand is live, where an
// affirmative almost always answers "want the next hand?".
const DEAL_INTENT = /\b(deal|next hand|new hand|another (one|hand)|let'?s (play|go|do it)|i'?m ready|ready|yes|yeah|yep|sure|okay|ok)\b/i;

// ── Silence watchdog ─────────────────────────────────────────────────────────
// When NOBODY has produced anything — no avatar audio, no player turn — for
// this long, the avatar is prodded (an appended instruction) to check in on the
// player. Note `lastAudioAt` is generation time and generation runs seconds
// ahead of the avatar's voice, so the threshold has to absorb that lead: by
// the time this fires, the played-back silence is shorter than the number says.
const SILENCE_CHECKIN_MS = 12_000;
const SILENCE_POLL_MS = 3_000;
// Floor between check-ins, for a model that ignores the first prod — without
// it every poll tick past the threshold re-prods, which is nagging, not care.
const CHECKIN_COOLDOWN_MS = 20_000;

export class Session implements GptLiveEvents {
  readonly bridge: GptLiveBridge;
  readonly media: MediaServerLeg;

  private frontend: WebSocket | null = null;
  private ready = false;
  private stopping = false;
  private lastAudioAt: number | null = null;
  private lastInterruptAt: number | null = null;
  private interruptWatch: NodeJS.Timeout | null = null;
  /** Bumped by mic frames — the idle watchdog's only liveness signal. */
  lastActivityAt = Date.now();
  readonly startedAt = Date.now();

  // The simulator — the single source of game truth for this session.
  private readonly game = new PokerGame();
  // Armed when the user sounded like they asked for a hand; cleared when a
  // deal_next_hand delegation delivers it, fired if it never does.
  private dealFallback: NodeJS.Timeout | null = null;

  // ── Silence watchdog state ──
  private lastUserActivityAt: number | null = null;
  private lastCheckinAt: number | null = null;
  private readyAt: number | null = null;
  private silencePoll: NodeJS.Timeout | null = null;

  constructor(
    readonly sessionId: string,
    mediaWsUrl: string,
    /** Called when a leg dies and the session can no longer work. */
    private readonly onDead: (sessionId: string) => void,
  ) {
    this.media = new MediaServerLeg(mediaWsUrl, (msg) => this.log(msg));
    this.bridge = new GptLiveBridge(this, (msg) => this.log(msg));
  }

  /** Spawn both legs; whichever exits first ends the session. */
  start(): void {
    void this.runLeg("media server", () => this.media.run());
    void this.runLeg("GPT-Live", async () => {
      if (!(await this.media.waitUntilReady(MEDIA_READY_TIMEOUT_MS))) {
        // Said out loud: without this the avatar simply never speaks while the
        // transcript keeps printing, and the only person who can't tell why is
        // the user.
        this.emit({
          type: "error",
          message: "the avatar could not be reached — start a new session",
        });
        return;
      }
      await this.bridge.run();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interruptWatch) clearTimeout(this.interruptWatch);
    if (this.silencePoll) clearInterval(this.silencePoll);
    if (this.dealFallback) clearTimeout(this.dealFallback);
    // Bridge first: GPT-Live gets its session.close and the drain still
    // delivers the last audio into the media leg before it closes.
    await this.bridge.close();
    this.media.close();
    this.frontend = null;
  }

  /**
   * Claim the single frontend slot; false if one is already attached.
   * Synchronous check-and-set, so two upgrades racing for the same session
   * cannot both win.
   */
  tryAttachFrontend(ws: WebSocket): boolean {
    if (this.frontend) return false;
    this.frontend = ws;
    // Replay `ready` to a browser that attached after the bridge came up, so a
    // slow tab doesn't miss the one `ready` that ever fires.
    if (this.ready) this.emit({ type: "ready" });
    return true;
  }

  detachFrontend(ws: WebSocket): void {
    // Identity-keyed so a stale socket cannot clear a newer connection.
    if (this.frontend === ws) this.frontend = null;
  }

  sendMicAudio(audioB64: string): void {
    this.lastActivityAt = Date.now();
    this.bridge.sendMicAudio(audioB64);
  }

  // ── GptLiveEvents ──────────────────────────────────────────────────────────

  onReady(): void {
    this.ready = true;
    this.readyAt = Date.now();
    this.log("GPT-Live ready");
    this.emit({ type: "ready" });
    this.silencePoll = setInterval(() => this.checkSilence(), SILENCE_POLL_MS);
  }

  onAudio(audioB64: string): void {
    this.lastAudioAt = Date.now();
    this.media.speak(audioB64);
  }

  onTurn(turn: Turn): void {
    this.emit({ type: "turn", ...turn });
    if (turn.role !== "user") return;
    this.lastUserActivityAt = Date.now();

    // Deal fallback: the user sounded like they asked for a hand while none
    // is live. Give the delegation path first shot; deal directly if it never
    // fires. Finished turns only — partial transcripts false-match too easily.
    if (
      turn.done &&
      !this.game.handInProgress &&
      !this.dealFallback &&
      DEAL_INTENT.test(turn.text)
    ) {
      this.dealFallback = setTimeout(() => {
        this.dealFallback = null;
        if (this.game.handInProgress || this.stopping) return;
        this.log("deal fallback: model did not delegate — dealing directly");
        const outcome = this.game.startHand();
        this.pushTable(outcome);
        // An instruction on purpose: the model must react NOW and read the
        // hand out — the mid-session-append pacing risk is the point here.
        this.bridge.append(
          "instructions",
          DEAL_FALLBACK_PROMPT + this.game.describe(),
        );
      }, DEAL_DELEGATION_TIMEOUT_MS);
    }
  }

  onUserTurnStarted(): void {
    this.lastUserActivityAt = Date.now();
    if (this.interruptWatch) return; // already watching this interruption
    this.interruptWatch = setTimeout(() => {
      this.interruptWatch = null;
      this.stopStaleAudio();
    }, YIELD_GRACE_MS);
  }

  onToolCall(
    name: string | null,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved = name || inferToolName(args);
    switch (resolved) {
      case "deal_next_hand": {
        if (this.game.handInProgress) {
          return {
            ok: false,
            error: "a hand is already in progress — finish it first",
            state: this.game.describe(),
          };
        }
        // The delegation delivered the deal — the fallback push is redundant.
        if (this.dealFallback) {
          clearTimeout(this.dealFallback);
          this.dealFallback = null;
        }
        const outcome = this.game.startHand();
        this.log(`tool → deal_next_hand (hand #${this.game.handNumber})`);
        this.pushTable(outcome);
        return { ok: true, happened: outcome.narration, state: this.game.describe() };
      }

      case "player_action": {
        if (!this.game.handInProgress) {
          return {
            ok: false,
            error: "no hand in progress — deal one first with deal_next_hand",
            state: this.game.describe(),
          };
        }
        const parsed = parsePlayerAction(args);
        if (!parsed) {
          return {
            ok: false,
            error: "unrecognized action — use bet, raise, check, call, or fold",
            state: this.game.describe(),
          };
        }
        const outcome = this.game.act(parsed.action, parsed.amountBb);
        this.log(
          `tool → player_action ${parsed.action}${parsed.amountBb ? ` ${parsed.amountBb}bb` : ""} — ${outcome.narration.slice(0, 100)}`,
        );
        this.pushTable(outcome);
        return {
          ok: true,
          happened: outcome.narration,
          hand_over: outcome.handOver,
          state: this.game.describe(),
        };
      }

      default:
        this.log(
          `tool call ignored: ${resolved ?? "(unnamed)"} ${JSON.stringify(args).slice(0, 120)}`,
        );
        // Still a result — an unanswered call stays pending and blocks every
        // later delegation.
        return { ok: false, error: "unknown tool; nothing happened" };
    }
  }

  onError(message: string): void {
    this.log(`error: ${message}`);
    this.emit({ type: "error", message });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The shared tail of every game move: the table state goes to the browser
   * as a ui message, and a [GAME STATE] line goes into the live model's
   * context as THINKING — v3's silent channel — so its between-delegation
   * coaching talks about the real board, not a remembered one. Not
   * `commentary`: in v3 that is speakable, and the avatar would read the
   * state line aloud.
   */
  private pushTable(outcome: ActionOutcome): void {
    this.emit({ type: "ui", ...tableUi(outcome.snapshot, outcome.reveal) });
    this.bridge.append("thinking", `[GAME STATE] ${this.game.describe()}`);
  }

  /**
   * The dead-air killer. If neither side has produced anything for a while —
   * no avatar audio generated, no player turn heard — prod the avatar to
   * check in ("still there?", restate the spot). Its own check-in speech
   * bumps lastAudioAt, which re-arms the watchdog naturally.
   */
  private checkSilence(): void {
    if (this.stopping) return;
    const now = Date.now();
    const lastSignal = Math.max(
      this.readyAt ?? this.startedAt,
      this.lastAudioAt ?? 0,
      this.lastUserActivityAt ?? 0,
    );
    if (now - lastSignal < SILENCE_CHECKIN_MS) return;
    if (
      this.lastCheckinAt !== null &&
      now - this.lastCheckinAt < CHECKIN_COOLDOWN_MS
    )
      return;
    this.lastCheckinAt = now;
    const quiet = (at: number | null) =>
      at === null ? "never" : `${Math.round((now - at) / 1000)}s`;
    this.log(
      `silence — prompting a check-in (avatar quiet ${quiet(this.lastAudioAt)}, player quiet ${quiet(this.lastUserActivityAt)})`,
    );
    this.bridge.append("instructions", SILENCE_CHECKIN);
  }

  /**
   * Clear the avatar's buffer, but only once the model has given up on it.
   * Clearing is destructive and unilateral — the media server drops audio
   * GPT-Live thinks it delivered, and nothing will produce it again — so it is
   * worth doing in exactly one state: the model has stopped speaking and the
   * avatar has not caught up yet.
   */
  private stopStaleAudio(): void {
    const last = this.lastAudioAt;
    if (last === null || this.stopping) return;
    if (
      this.lastInterruptAt !== null &&
      Date.now() - this.lastInterruptAt < INTERRUPT_COOLDOWN_MS
    ) {
      return;
    }
    const quietFor = Date.now() - last;
    // Still talking over the user → the model kept the floor (backchannel).
    if (quietFor < YIELD_QUIET_MS) return;
    // Long quiet → nothing left playing; clearing would empty an empty buffer.
    if (quietFor > YIELD_STALE_MS) return;
    this.lastInterruptAt = Date.now();
    this.log("user barge-in — clearing avatar audio buffer");
    this.media.interrupt();
    // The rest of that sentence is never coming; tell the browser so it can
    // reflect it (e.g. mark the transcript line).
    this.emit({ type: "interrupted" });
  }

  private async runLeg(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (!this.stopping)
        this.log(
          `${name} leg failed: ${err instanceof Error ? err.message : err}`,
        );
    }
    if (this.stopping) return;
    // Neither leg reconnects forever, and a session with one live leg is
    // useless — GPT-Live would stream into a closed socket, or the avatar
    // would sit mute — so the survivor is not left running.
    this.log(`${name} leg exited — ending session`);
    this.emit({ type: "error", message: `the ${name} connection dropped` });
    this.onDead(this.sessionId);
  }

  private emit(message: ServerMessage): void {
    const ws = this.frontend;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.frontend = null;
    }
  }

  private log(msg: string): void {
    console.log(`[session ${this.sessionId.slice(0, 8)}] ${msg}`);
  }
}
