/**
 * Server-side connection to a LITE session's media-server websocket — the
 * avatar's ear. GPT-Live's audio is threaded straight in from here, instead of
 * round-tripping through the browser.
 *
 * Protocol (https://docs.liveavatar.com/docs/lite-mode/events.md):
 *   → agent.speak          { type, audio }        append PCM16 24kHz base64
 *   → agent.interrupt      { type }               drop queued + playing speech
 *   → session.keep_alive   { type, event_id }     extend the inactivity window
 *   ← session.state_updated{ state }              "connected" gates everything
 *
 * Commands sent before the server reports state "connected" are silently
 * dropped, so readiness here means that event has arrived — not that the
 * socket opened.
 *
 * Continuous-stream philosophy: one never-ending utterance. No `speak_end` per
 * turn — GPT-Live audio chunks are forwarded in arrival order and
 * the avatar simply renders it. The one exception is `interrupt`: audio
 * arrives faster than it plays, so the media server can be holding several
 * seconds of speech the model has already abandoned. When the user talks over
 * the avatar, that queue is what keeps talking — clearing it is the only fix.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PING_INTERVAL_MS = 30_000;
const MAX_CONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;
// A connection that survived this long counts as recovery, so the attempt
// counter resets — without this a server that accepts and immediately drops
// would defeat the attempt cap forever.
const STABLE_CONNECTION_MS = 5_000;

// The session dies after 5 minutes of inactivity. A conversation normally
// keeps it alive on its own; this covers a long stretch where the model has
// nothing to say (the user monologuing — their audio goes to GPT-Live, not
// here). Docs recommend every 2–3 minutes.
const KEEP_ALIVE_INTERVAL_MS = 120_000;

/** A promise-backed flag, the async primitive `waitUntilReady` needs. */
function flag() {
  let resolve!: () => void;
  let promise: Promise<void>;
  const arm = () => {
    promise = new Promise<void>((r) => (resolve = r));
  };
  arm();
  let isSet = false;
  return {
    set: () => {
      isSet = true;
      resolve();
    },
    clear: () => {
      if (!isSet) return;
      isSet = false;
      arm();
    },
    get value() {
      return isSet;
    },
    /** Resolve true when set within `timeoutMs`, false otherwise. */
    wait: (timeoutMs: number): Promise<boolean> => {
      if (isSet) return Promise.resolve(true);
      return new Promise((r) => {
        const timer = setTimeout(() => r(false), Math.max(0, timeoutMs));
        void promise.then(() => {
          clearTimeout(timer);
          r(true);
        });
      });
    },
  };
}

export class MediaServerLeg {
  private ws: WebSocket | null = null;
  private closed = false;
  /** Set when the server reports state "connected" — not on socket open. */
  private readonly connected = flag();

  constructor(
    private readonly wsUrl: string,
    private readonly log: (msg: string) => void,
  ) {}

  /**
   * Block until the server has said "connected" — the point after which
   * commands are no longer dropped. Resolves false on timeout.
   */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      if (!(await this.connected.wait(remaining))) return false;
      if (this.closed) return false;
      if (this.connected.value) return true;
      // Dropped between set and here; loop back for the reconnect.
    }
  }

  /**
   * Hold the connection open until closed, reconnecting with backoff on a
   * drop. Audio produced during a reconnect gap is lost — there is no replay,
   * and holding it back would only desync the avatar further.
   */
  async run(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      const connectedAt = await this.connectOnce();

      if (this.closed) return;

      if (connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS) attempt = 0;
      attempt += 1;
      if (attempt >= MAX_CONNECT_ATTEMPTS) {
        this.log(`media server: gave up after ${attempt} attempts`);
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
      this.log(`media server: reconnecting in ${delay}ms (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** One connection lifetime. Resolves with when it connected (null if never). */
  private connectOnce(): Promise<number | null> {
    return new Promise((resolve) => {
      let connectedAt: number | null = null;
      const ws = new WebSocket(this.wsUrl);
      const timers: NodeJS.Timeout[] = [];

      const finish = () => {
        timers.forEach(clearInterval);
        this.ws = null;
        this.connected.clear();
        resolve(connectedAt);
      };

      ws.on("open", () => {
        this.ws = ws;
        connectedAt = Date.now();
        timers.push(setInterval(() => ws.ping(), PING_INTERVAL_MS));
        timers.push(
          setInterval(
            () => this.send({ type: "session.keep_alive", event_id: randomUUID() }),
            KEEP_ALIVE_INTERVAL_MS,
          ),
        );
        // Not ready yet: commands are dropped until the server reports
        // state "connected".
      });
      ws.on("message", (raw) => this.onServerEvent(raw.toString()));
      ws.on("error", (err) => this.log(`media server: ${err.message}`));
      ws.on("close", finish);
    });
  }

  /**
   * Append one audio chunk to the avatar's playback buffer, exactly as
   * GPT-Live produced it. Coalescing here would only add latency — the media
   * server buffers and cuts its own inference-sized chunks. (Chunks stay well
   * under the documented 1MB cap: a GPT-Live delta is under a second of audio,
   * and the widest silence pad is 800ms ≈ 38KB.)
   */
  speak(audioB64: string): void {
    this.send({ type: "agent.speak", audio: audioB64 });
  }

  /**
   * Cut the avatar off mid-sentence: drops queued and in-flight speech,
   * returns the avatar to idle. GPT-Live needs no telling — it is full-duplex
   * and yields on its own; what it cannot undo is the audio already handed
   * over here.
   */
  interrupt(): void {
    this.send({ type: "agent.interrupt" });
  }

  close(): void {
    this.closed = true;
    // Unblocks anyone in waitUntilReady on a session torn down before the
    // socket ever came up.
    this.connected.set();
    this.ws?.close();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected.value) {
      // Not connected (or mid-reconnect). Dropping is the only honest option —
      // see run(); the server would drop it silently anyway.
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private onServerEvent(raw: string): void {
    let event: { type?: string; state?: string };
    try {
      event = JSON.parse(raw) as { type?: string; state?: string };
    } catch {
      return;
    }
    if (event.type === "session.state_updated") {
      this.log(`media server: state ${event.state}`);
      if (event.state === "connected") this.connected.set();
      else if (event.state === "closing" || event.state === "closed") this.connected.clear();
    } else if (event.type === "error") {
      this.log(`media server error event: ${raw.slice(0, 300)}`);
    }
  }
}
