/**
 * Wiring between a session's three websockets.
 *
 * A `Session` owns the two upstream legs (GPT-Live, media server) and the
 * single browser socket, and implements the sink the bridge emits into: audio
 * goes to the media server; transcripts and tool calls go to the browser.
 *
 * Note what does NOT go to the browser: avatar audio. It reaches the browser
 * through LiveKit, because this server threads it into the media server
 * directly.
 */

import type WebSocket from "ws";
import type { ServerMessage, Turn } from "../../shared/messages";
import { GptLiveBridge, type GptLiveEvents } from "./gptlive";
import { MediaServerLeg } from "./mediaServer";
import { SILENCE_CHECKIN } from "./prompts";
import { dispatchToolCall } from "./tools";

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

// ── Pricing sheet push ───────────────────────────────────────────────────────
// The most reliable visual trigger is no trigger at all: the server watches
// the AVATAR's transcript, and the first time it is heard talking prices the
// sheet is pushed directly — same dispatcher, same wire message, no tool call
// involved. Delegation (the show_pricing_sheet tool) is the preferred path
// because its spoken reply reads the sheet's rows back; this watch is the
// insurance for when the live model answers pricing out loud without
// delegating, which it is documented to do.
const PRICING_PATTERN = /\bcredits?\b|\bpricing\b|\bper[ -]minute\b|\bper[ -]credit\b/i;
// Floor between pushes, so a long pricing conversation doesn't replay the
// sheet on every sentence — and so a sheet the delegation just rendered isn't
// immediately re-pushed by the transcript mentioning what it said.
const PRICING_PUSH_COOLDOWN_MS = 60_000;

// ── Mode comparison push ─────────────────────────────────────────────────────
// Same insurance as the pricing sheet, for the other question this demo gets
// constantly: Full mode versus Avatar Only. The pattern is deliberately
// narrow — "mode" alone matches far too much speech, so a hit needs the mode
// actually being named.
const MODE_PATTERN = /\b(full|lite|avatar[ -]only)\b[^.?!]{0,40}\bmode\b|\bmode\b[^.?!]{0,40}\b(full|lite|avatar[ -]only)\b/i;
const MODE_PUSH_COOLDOWN_MS = 90_000;

// ── Support hand-off push ────────────────────────────────────────────────────
// The hand-off is the one visual that must NOT depend on the model choosing
// to call its tool: the moment the avatar says "that has to go through HeyGen
// support", the user needs the address in front of them, and a turn where the
// model spoke the hand-off but skipped show_support_contact leaves them with
// an email address they heard once and cannot copy.
//
// So the server watches for the hand-off being SPOKEN and pushes the card
// itself. The pattern matches the ways the avatar actually hands off — the
// spoken address, "the support team", "contact/email support" — and
// deliberately not the bare word "support", which appears in the greeting
// ("the LiveAvatar support assistant") and would fire on hello.
const HANDOFF_PATTERN =
  /support\s*(?:@|\bat\b)\s*(?:heygen|live\s*avatar)|\bsupport\s+team\b|\b(?:contact|email|reach(?:\s+out)?\s+to|talk\s+to|go\s+through)\s+(?:the\s+)?(?:heygen\s+|live\s*avatar\s+)?support\b/i;
// Long: a hand-off is a dead end for the conversation, so re-showing the same
// card is noise rather than help.
const HANDOFF_PUSH_COOLDOWN_MS = 180_000;

/**
 * Subject line for a pushed hand-off, inferred from what was actually said.
 * The tool path gets a real summary from the model; this path only has the
 * transcript, so the subject is the one piece of routing worth guessing —
 * "Refund request" reaching the right queue beats a generic subject.
 */
function inferHandoffTopic(text: string): string {
  if (/\brefund|charged?\s+twice|double[- ]charg|dispute|chargeback\b/i.test(text)) {
    return "Refund request";
  }
  if (/\bapprov|moderation|reject(?:ed)?|custom avatar\b/i.test(text)) {
    return "Custom avatar approval";
  }
  if (/\blog\s?in|login|password|locked out|can.?t access my account|account access\b/i.test(text)) {
    return "Account access";
  }
  if (/\benterprise|quote|sales team|annual|invoice\b/i.test(text)) {
    return "Enterprise enquiry";
  }
  return "LiveAvatar support request";
}

// ── Silence watchdog ─────────────────────────────────────────────────────────
// When NOBODY has produced anything — no avatar audio, no user turn — for
// this long, the avatar is prodded (an appended instruction) to check in on the
// user. Note `lastAudioAt` is generation time and generation runs seconds
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
  // When the pricing sheet last went up, by either path (tool call or
  // transcript push) — the cooldown reads this so the two paths cannot
  // double-fire each other.
  private lastPricingShownAt: number | null = null;
  // Same, for the mode comparison.
  private lastModesShownAt: number | null = null;
  // Same, for the support hand-off card.
  private lastHandoffShownAt: number | null = null;
  /**
   * The user's most recent turn, verbatim. It becomes the body of the
   * pre-filled email when the SERVER pushes the hand-off card: their own
   * words are a better draft than anything the server could compose, and on
   * this path there is no model reply to summarize.
   */
  private lastUserText: string | null = null;

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
    if (turn.role === "user") {
      this.lastUserActivityAt = Date.now();
      // Streaming updates re-send the same turn with longer text, so the last
      // write for a turn is its complete text.
      const text = turn.text.trim();
      if (text) this.lastUserText = text;
      return;
    }
    // Pricing sheet: the SERVER pushes it the first time the avatar is heard
    // talking prices — checked on every streaming update so the sheet lands
    // mid-sentence, alongside the numbers, not after the turn. Passive on
    // purpose: it never writes into the conversation, so it cannot disturb
    // the model's own pacing. The delegation path (show_pricing_sheet) also
    // exists and is preferred when it fires — this is the insurance, and the
    // shared cooldown keeps the two from stacking.
    const now = Date.now();

    // The hand-off outranks both panels: if the avatar is saying "that has to
    // go through support", the address is the only thing on screen worth
    // showing, and a plan table next to it is a distraction.
    if (
      HANDOFF_PATTERN.test(turn.text) &&
      (this.lastHandoffShownAt === null ||
        now - this.lastHandoffShownAt >= HANDOFF_PUSH_COOLDOWN_MS)
    ) {
      const ui = dispatchToolCall("show_support_contact", {
        // The user's own words, so the draft reads like their request. With
        // no user turn on record (the avatar volunteered the hand-off), a
        // neutral opener still beats a card with an empty body.
        summary:
          this.lastUserText ??
          "I was talking to the LiveAvatar support avatar and need help with the following:",
        topic: inferHandoffTopic(`${this.lastUserText ?? ""} ${turn.text}`),
      });
      if (ui) {
        this.lastHandoffShownAt = now;
        this.log("handoff: avatar is pointing at support — pushing the card");
        this.emit({ type: "ui", ...ui });
        return;
      }
    }

    // The mode comparison goes next: a sentence naming Full and Lite mode
    // usually names their credit rates too, and the comparison is the better
    // answer to that sentence than the plan table.
    if (
      MODE_PATTERN.test(turn.text) &&
      (this.lastModesShownAt === null || now - this.lastModesShownAt >= MODE_PUSH_COOLDOWN_MS)
    ) {
      const ui = dispatchToolCall("show_mode_comparison", {
        headline: "Two ways to run LiveAvatar",
      });
      if (ui) {
        this.lastModesShownAt = now;
        // Arm pricing too: the comparison already shows both credit rates, so
        // the sheet would only be talking over it.
        this.lastPricingShownAt = now;
        this.log("modes: avatar is comparing modes — pushing the comparison");
        this.emit({ type: "ui", ...ui });
        return;
      }
    }

    if (!PRICING_PATTERN.test(turn.text)) return;
    if (
      this.lastPricingShownAt !== null &&
      now - this.lastPricingShownAt < PRICING_PUSH_COOLDOWN_MS
    ) {
      return;
    }
    const ui = dispatchToolCall("show_pricing_sheet", {
      title: "LiveAvatar pricing",
    });
    if (!ui) return;
    this.lastPricingShownAt = now;
    this.log("pricing: avatar is talking prices — pushing the sheet");
    this.emit({ type: "ui", ...ui });
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
    const ui = dispatchToolCall(name, args);
    if (!ui) {
      this.log(
        `tool call ignored: ${name ?? "(unnamed)"} ${JSON.stringify(args).slice(0, 120)}`,
      );
      // Still a result — an unanswered call stays pending and blocks every
      // later delegation.
      return {
        shown: false,
        error: "unknown tool or invalid arguments; nothing was displayed",
      };
    }
    this.log(`tool → ${ui.widget} ${JSON.stringify(ui.props).slice(0, 120)}`);
    this.emit({ type: "ui", ...ui });
    if (ui.widget === "mode_comparison") {
      this.lastModesShownAt = Date.now();
      // The comparison carries both credit rates; keep the sheet from
      // stacking on top of it.
      this.lastPricingShownAt = Date.now();
      // Hand back both columns: the backend continues its reply from here,
      // and these are the capabilities it should describe.
      return { shown: true, full: ui.props.full, lite: ui.props.lite };
    }
    if (ui.widget === "support_contact") {
      // Arm the cooldown so the transcript watch doesn't push a second card
      // when the model speaks the address it just put on screen.
      this.lastHandoffShownAt = Date.now();
      // The address is server-owned, so hand it back for the model to say
      // out loud — and say plainly that nothing has been sent, so the reply
      // cannot promise a ticket that does not exist.
      return {
        shown: true,
        email: ui.props.email,
        sent: false,
        note: "A pre-filled draft is on screen; the user still has to click it and send.",
      };
    }
    if (ui.widget === "pricing_sheet") {
      // The model delivered the sheet — arm the cooldown so the transcript
      // watch doesn't re-push it when the avatar speaks the numbers.
      this.lastPricingShownAt = Date.now();
      // Hand back the exact rows on the sheet: the backend continues its
      // reply after this result, and these are the prices it should speak.
      // The invariant holds — the model still cannot SUPPLY a price; it can
      // only read back what the server put on screen.
      return { shown: true, rows: ui.props.rows };
    }
    return { shown: true };
  }

  onError(message: string): void {
    this.log(`error: ${message}`);
    this.emit({ type: "error", message });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The dead-air killer. If neither side has produced anything for a while —
   * no avatar audio generated, no user turn heard — prod the avatar to
   * check in ("are you still there?"). Its own check-in speech bumps
   * lastAudioAt, which re-arms the watchdog naturally.
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
      `silence — prompting a check-in (avatar quiet ${quiet(this.lastAudioAt)}, user quiet ${quiet(this.lastUserActivityAt)})`,
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
