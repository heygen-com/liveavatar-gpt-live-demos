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
import type { ServerMessage, TermCardProps, Turn } from "../../shared/messages";
import { GptLiveBridge, type GptLiveEvents } from "./gptlive";
import { MediaServerLeg } from "./mediaServer";
import { LESSON_WORDS, REVIEW_BREAK_PROMPT, SILENCE_CHECKIN } from "./prompts";
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

// Auto-recap cadence: every time this many NEW words have been taught, the
// server pushes the recap panel (last RECAP_EVERY_WORDS words) on the next
// finished assistant turn. Server-pushed like the lesson cards, and for the
// same reason: the model has no incentive to recap unprompted, and asking it
// to is the delegation-that-never-fires problem all over again.
const RECAP_EVERY_WORDS = 4;
// How long to wait for the model to deliver the requested review via
// delegation before the server pushes the panel itself. Generous: a
// delegation round trip is ~1s, but the prompt tells the model to finish the
// current exchange first.
const REVIEW_DELEGATION_TIMEOUT_MS = 10_000;

// ── Silence watchdog ─────────────────────────────────────────────────────────
// When NOBODY has produced anything — no avatar audio, no learner turn — for
// this long, the avatar is prodded (an appended instruction) to check in on the
// learner. Note `lastAudioAt` is generation time and generation runs seconds
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
  // Every term card shown this session, in teaching order — the store the
  // recap panel (show_learned_words) renders from. The model asks for the
  // recap; it never supplies this list.

  private readonly learnedWords: TermCardProps[] = [];
  // Lesson words whose card has already been pushed. The lesson itself lives
  // in the model's startup instructions (LESSON_DIRECTIVE) — the server only
  // watches the transcript and puts each word's card up the first time the
  // tutor says it. No pacing state: the model owns the conversation cycle.
  private readonly taughtLessonTerms = new Set<string>();
  // How many words learnedWords held at the last auto-recap, so the next one
  // fires only after RECAP_EVERY_WORDS genuinely new words.
  private wordsAtLastRecap = 0;
  // Armed when a review break has been requested; cleared when the model's
  // delegation delivers the panel, fired if it never does.
  private reviewFallback: NodeJS.Timeout | null = null;

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
    if (this.reviewFallback) clearTimeout(this.reviewFallback);
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
      return;
    }
    // Lesson cards: the SERVER pushes a word's card the first time the tutor
    // is heard saying it — checked on every streaming update so the card lands
    // mid-sentence, alongside the word, not after the turn. Passive on
    // purpose: it never writes into the conversation, so it cannot disturb
    // the model's own pacing. (The model is not asked to delegate for words
    // we already hold — a full session of asking closed with
    // backend_model_usage: [].)
    for (const word of LESSON_WORDS) {
      if (
        this.taughtLessonTerms.has(word.term) ||
        !turn.text.includes(word.term)
      )
        continue;
      this.taughtLessonTerms.add(word.term);
      this.log(`lesson: tutor said "${word.term}" — pushing card`);
      this.showTermCard({
        term: word.term,
        reading: word.reading,
        meaning: word.meaning,
      });
      return;
    }

    // Review break, on the turn boundary so it lands between beats rather
    // than over a word mid-teach. The server only ASKS: the live model hands
    // the turn to its backend, whose show_learned_words call renders the
    // panel, and whose tool result hands back the exact words — so its spoken
    // walkthrough and the rows on screen are synchronized by the conversation
    // itself, not by a timer guessing at speech cadence.
    if (!turn.done) return;
    if (this.learnedWords.length - this.wordsAtLastRecap < RECAP_EVERY_WORDS) {
      return;
    }
    this.wordsAtLastRecap = this.learnedWords.length;
    this.log("review break: asking the model to delegate the recap");
    this.bridge.append("instructions", REVIEW_BREAK_PROMPT);
    // Insurance, not the plan: the live model has a documented history of not
    // delegating when asked. If no recap renders in time, push the panel
    // directly — the visual must not depend on obedience.
    this.reviewFallback = setTimeout(() => {
      this.reviewFallback = null;
      const ui = dispatchToolCall(
        "show_learned_words",
        { title: "Words so far" },
        this.learnedWords,
      );
      if (!ui) return;
      this.log("review break: model did not delegate — pushing panel directly");
      this.emit({ type: "ui", ...ui });
    }, REVIEW_DELEGATION_TIMEOUT_MS);
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
    const ui = dispatchToolCall(name, args, this.learnedWords);
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
    if (ui.widget === "term_card") {
      // showTermCard records the word for the recap — the model asks for the
      // recap but never supplies the list.
      this.showTermCard(ui.props);
      return { shown: true };
    }
    this.emit({ type: "ui", ...ui });
    if (ui.widget === "learned_words") {
      // The model delivered the review — the fallback push is now redundant.
      if (this.reviewFallback) {
        clearTimeout(this.reviewFallback);
        this.reviewFallback = null;
      }
      // Hand back the exact words on the panel: the backend continues its
      // reply after this result, and these are what it should walk through.
      // The invariant holds — the model still cannot SUPPLY the list; it can
      // only read back what the server put on screen.
      return { shown: true, words: ui.props.words };
    }
    return { shown: true };
  }

  onError(message: string): void {
    this.log(`error: ${message}`);
    this.emit({ type: "error", message });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Put a term card up and remember it for the recap — the shared tail of the
   * two ways a card can happen: the backend's tool call and the scripted
   * lesson's server-side push.
   */
  private showTermCard(props: TermCardProps): void {
    if (!this.learnedWords.some((w) => w.term === props.term)) {
      this.learnedWords.push(props);
    }
    this.emit({ type: "ui", widget: "term_card", props });
  }

  /**
   * The dead-air killer. If neither side has produced anything for a while —
   * no avatar audio generated, no learner turn heard — prod the avatar to
   * check in ("are you still there?", "you've got this"). Its own check-in
   * speech bumps lastAudioAt, which re-arms the watchdog naturally.
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
      `silence — prompting a check-in (avatar quiet ${quiet(this.lastAudioAt)}, learner quiet ${quiet(this.lastUserActivityAt)})`,
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
