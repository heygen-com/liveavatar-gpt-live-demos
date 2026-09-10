/**
 * Per-session GPT-Live upstream websocket — the v3 contract (`gpt-live-1`).
 *
 * GPT-Live is full-duplex: one continuous audio stream in each direction, and
 * the model manages turn-taking itself. Rather than manufacturing turn
 * boundaries to fit a turn-based protocol, the avatar is treated as a pure
 * audio-to-face renderer fed ONE continuous stream: forward audio as it
 * arrives, never send an end-of-speech. The model yields on its own; when it
 * goes quiet the stream simply stops.
 *
 * v3 differences that shaped this file (see docs/ARCHITECTURE.md):
 *  - startup is one `session.start` carrying the whole config, model included;
 *  - audio deltas have no timeline fields — chunks are forwarded in order;
 *  - there are no turn events — turns are projected from transcript deltas
 *    (turns.ts);
 *  - Responses events arrive wrapped in `response.event`;
 *  - a tool result is `response.item.create` AND THEN `response.create` — the
 *    result alone does not resume the backend.
 */

import WebSocket from "ws";
import type { Turn } from "../../shared/messages";
import { toolSchemas } from "../../shared/tools";
import { config } from "./config";
import {
  CLIENT_DELEGATION_STUB,
  DEFAULT_GREETING,
  DEFAULT_INSTRUCTIONS,
  GREETING_PREAMBLE,
  LESSON_DIRECTIVE,
  LIVE_DIRECTIVE,
  RESPONSES_INSTRUCTIONS,
} from "./prompts";
import { TurnProjector } from "./turns";

// v3: no `?model=` — the model travels in `session.start`.
const BASE_URL = "wss://api.openai.com/v1/live/sessions";

// How long to keep reading after `session.close` before dropping the socket.
// The service drains in-flight work and only then emits `session.closed`;
// dropping the transport earlier cuts the avatar off mid-word.
const CLOSE_DRAIN_TIMEOUT_MS = 3_000;

// Custom voices are named by id and must be sent as an object; the API
// reserves bare strings for its own named voices ("marin", "cedar", ...), so a
// custom id sent as a string is rejected as an unknown voice.
const voiceField = (voice: string): string | { id: string } =>
  voice.startsWith("voice_") ? { id: voice } : voice;

type Json = Record<string, any>;

/** Commands this client sends into the session stream. */
enum GPTLiveClientEvent {
  SessionStart = "session.start",
  SessionClose = "session.close",
  InputAudioAppend = "session.input_audio.append",
  // The three context appends. All take a plain-string `content` (≤500
  // tokens) and a REQUIRED `delegation_id` (null = general session context).
  InstructionsAppend = "session.instructions.append",
  ThinkingAppend = "session.thinking.append",
  CommentaryAppend = "session.commentary.append",
  // Responses-delegation only: queue a function result, then continue.
  ResponseItemCreate = "response.item.create",
  ResponseCreate = "response.create",
}

/** Events the service emits. Only the ones this bridge dispatches on. */
enum GPTLiveServerEvent {
  SessionStarted = "session.started",
  SessionClosed = "session.closed",
  SessionUsageUpdated = "session.usage.updated",
  OutputAudioDelta = "session.output_audio.delta",
  InputTranscriptDelta = "session.input_transcript.delta",
  OutputTranscriptDelta = "session.output_transcript.delta",
  DelegationCreated = "session.delegation.created",
  // Envelope for every Responses lifecycle event; dispatch on `event.event.type`.
  ResponseEvent = "response.event",
  InstructionsAppended = "session.instructions.appended",
  ThinkingAppended = "session.thinking.appended",
  CommentaryAppended = "session.commentary.appended",
  Error = "error",
}

/** Nested Responses events (inside `response.event`) this bridge acts on. */
enum ResponsesEvent {
  // Carries the COMPLETED function_call item — call_id, name, arguments.
  // `response.function_call_arguments.done` arrives first but has neither
  // call_id nor name, so this is the single event tool calls are driven from.
  OutputItemDone = "response.output_item.done",
  Completed = "response.completed",
  Failed = "response.failed",
  Incomplete = "response.incomplete",
}

/**
 * Which v3 append a piece of text goes out as:
 *  - `instructions`: a directive the model follows (speak first, check in,
 *    hand this turn to the backend). OpenAI's tested speak-first path.
 *  - `commentary`: information the model should SAY, paraphrased.
 *  - `thinking`: silent context the model may use later. (v2's silent
 *    `channel: "commentary"` maps HERE, not to commentary.)
 */
export type AppendKind = "instructions" | "commentary" | "thinking";

/** Where the bridge's output goes. The session (session.ts) implements this. */
export interface GptLiveEvents {
  onReady(): void;
  onAudio(audioB64: string): void;
  onTurn(turn: Turn): void;
  /** A user turn opened in the transcript — the barge-in signal. */
  onUserTurnStarted(): void;
  /**
   * One tool call. The returned object IS the function-call result sent back
   * to the API (JSON-stringified) — every actionable call must get exactly
   * one, or it stays pending server-side and blocks all later delegations.
   * Shape by convention: {shown: boolean, error?, words?} —
   * show_learned_words returns the exact words placed on the panel so the
   * backend can narrate them.
   */
  onToolCall(
    name: string | null,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  onError(message: string): void;
}

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private closedByServer: (() => void) | null = null;

  private readonly turns: TurnProjector;
  // call_ids already answered. Tool calls are driven only from the nested
  // response.output_item.done, which carries the id, so the id is the dedupe
  // key — and it doubles as the "exactly one result per call" guard: the API
  // rejects a second result for an already-resolved id
  // (function_call_output_already_submitted).
  private handledCalls = new Set<string>();
  private appendSeq = 0;
  // Event types already shape-logged. The first sighting of each type is
  // logged with its field NAMES — enough to answer "what is OpenAI actually
  // sending" without putting the user's conversation in a log file.
  // GPT_LIVE_DEBUG=1 logs full payloads.
  private readonly seenEventTypes = new Set<string>();

  constructor(
    private readonly events: GptLiveEvents,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.turns = new TurnProjector({
      onTurn: (turn) => this.events.onTurn(turn),
      onUserTurnStarted: () => this.events.onUserTurnStarted(),
    });
  }

  /** Connect and pump upstream events until the socket closes. */
  run(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(BASE_URL, {
        headers: {
          Authorization: `Bearer ${config.gptlive.apiKey}`,
        },
        maxPayload: 8 * 1024 * 1024, // audio deltas outgrow the default 1MB cap
      });
      this.ws = ws;

      ws.on("open", () => this.startSession());
      ws.on("message", (raw) => {
        try {
          this.handleEvent(JSON.parse(raw.toString()) as Json);
        } catch {
          // One malformed event must not kill the session's upstream loop.
          this.log("gptlive error: malformed event");
        }
      });
      ws.on("error", (err) => this.events.onError(err.message));
      ws.on("close", () => {
        this.ws = null;
        this.turns.dispose();
        resolve();
      });
    });
  }

  sendMicAudio(audioB64: string): void {
    this.send(GPTLiveClientEvent.InputAudioAppend, { audio: audioB64 });
  }

  /**
   * Add text to the running session (see AppendKind). Any of these is a guide,
   * not a command: the model may paraphrase or ignore it. Plain string, capped
   * at 500 tokens server-side — keep the text short. `delegation_id` is
   * required by the API even when null; a non-null value must name a known
   * CLIENT delegation (never a Responses one).
   */
  append(kind: AppendKind, text: string, delegationId: string | null = null): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.appendSeq += 1;
    const event =
      kind === "instructions"
        ? GPTLiveClientEvent.InstructionsAppend
        : kind === "commentary"
          ? GPTLiveClientEvent.CommentaryAppend
          : GPTLiveClientEvent.ThinkingAppend;
    this.send(event, {
      event_id: `${kind}_${this.appendSeq}`,
      delegation_id: delegationId,
      content: trimmed,
    });
  }

  /**
   * Ask for graceful shutdown, then let the service drain before hanging up.
   * The service finishes in-flight output and emits `session.closed`, closing
   * the transport itself — the timeout is for a session that will not close.
   */
  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    // Listener installed before the command goes out, per the guide.
    const drained = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CLOSE_DRAIN_TIMEOUT_MS);
      this.closedByServer = () => {
        clearTimeout(timer);
        resolve(true);
      };
      ws.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    this.send(GPTLiveClientEvent.SessionClose, { event_id: "close" });
    if (!(await drained)) ws.close();
  }

  private send(
    event: GPTLiveClientEvent,
    payload: Record<string, unknown> = {},
  ): void {
    payload.type = event.toString();
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(payload));
  }

  private startSession(): void {
    // The persona comes from server/prompts/instructions.md (see prompts.ts);
    // the directives are mechanics and always appended.
    // Persona + visual/delegation mechanics + the whole lesson plan, all at
    // startup: instructions are the one channel the live model reliably
    // follows, and mid-session appends broke its own practice pacing.
    const instructions =
      DEFAULT_INSTRUCTIONS + LIVE_DIRECTIVE + LESSON_DIRECTIVE;
    // v3: the FIRST message. Everything here is immutable afterwards except
    // delegation.responses settings (session.update) — and the delegation
    // TYPE is fixed for the session's life.
    this.send(GPTLiveClientEvent.SessionStart, {
      event_id: "start",
      session: {
        model: config.gptlive.model,
        instructions,
        audio: {
          // 24kHz PCM16 is also the default, but the media-server leg is
          // hard-coded to it (mediaServer.ts) — so name it rather than
          // inherit it. Shared input/output format.
          format: { type: "audio/pcm", rate: 24000 },
          output: { voice: voiceField(config.gptlive.voice) },
        },
        delegation: {
          type: "responses",
          responses: {
            model: config.gptlive.responsesModel,
            instructions: RESPONSES_INSTRUCTIONS,
            tools: toolSchemas(),
            tool_choice: "auto",
            // One visual per teaching moment — a constraint the model cannot
            // talk itself out of, unlike the prose asking for the same thing.
            // Also keeps the tool loop simple: one call per response, so one
            // result + one response.create.
            parallel_tool_calls: false,
            // The delegated turn is on the critical path for on-screen timing;
            // deliberation buys nothing for "pick a card and fill its fields".
            // Non-reasoning models reject the parameter outright, so only send
            // it to ones that accept it.
            reasoning: { effort: "low" },
          },
        },
      },
    });
  }

  private handleEvent(event: Json): void {
    this.debugEventShape(event);
    switch (event.type) {
      case GPTLiveServerEvent.SessionStarted:
        // The OpenAI-side session id — the one their logs and support know
        // this conversation by. Logged in full, always: correlating an
        // incident with OpenAI is impossible without it.
        this.sessionId = String(event.session?.id ?? "");
        this.log(
          `gptlive session started (openai id=${this.sessionId || "?"}` +
            (event.session?.expires_at
              ? `, expires_at=${event.session.expires_at}`
              : "") +
            ")",
        );
        this.sendGreeting();
        this.events.onReady();
        break;

      case GPTLiveServerEvent.OutputAudioDelta:
        // v3 carries no timeline on audio; chunks are forwarded in order and
        // the wall clock is the only timing there is.
        if (typeof event.delta === "string" && event.delta)
          this.events.onAudio(event.delta);
        break;

      // Timed transcript fragments (200ms frames, empty ones omitted). No turn
      // events exist in v3; turns.ts groups these into turns for the UI, the
      // lesson push, the review break and the barge-in watch.
      case GPTLiveServerEvent.InputTranscriptDelta:
      case GPTLiveServerEvent.OutputTranscriptDelta:
        this.turns.fragment(
          event.type === GPTLiveServerEvent.InputTranscriptDelta
            ? "user"
            : "assistant",
          String(event.delta ?? ""),
          typeof event.start_ms === "number" ? event.start_ms : null,
          typeof event.end_ms === "number" ? event.end_ms : null,
        );
        break;

      case GPTLiveServerEvent.DelegationCreated: {
        // The live model handed a turn to the backend. Responses-target
        // delegations run entirely server-side — their function calls arrive
        // inside response.event and are answered there. The metadata carries
        // no task text in v3.
        const d = event.delegation ?? {};
        this.log(
          `gptlive delegation created (target=${d.target ?? "?"}, id=${d.id ?? "?"})`,
        );
        // A client-target delegation should never happen in this
        // configuration, but if one arrives the model is blocked waiting on
        // us — unblock it rather than let the session freeze on "one sec".
        // Commentary (speakable) with the delegation's own id: the stub has to
        // release the model into speech, not sit silently in context.
        if (d.target === "client" && typeof d.id === "string") {
          this.append("commentary", CLIENT_DELEGATION_STUB, d.id);
        }
        break;
      }

      case GPTLiveServerEvent.ResponseEvent:
        this.handleResponsesEvent(event.event, event.delegation_id);
        break;

      case GPTLiveServerEvent.InstructionsAppended:
      case GPTLiveServerEvent.ThinkingAppended:
      case GPTLiveServerEvent.CommentaryAppended:
        // Acceptance receipt, correlated by client_event_id. Not proof the
        // model spoke anything.
        if (config.gptlive.debug)
          this.log(`gptlive ${event.type} (${event.client_event_id ?? "?"})`);
        break;

      case GPTLiveServerEvent.SessionClosed:
        // Finalization. `reason` says whether it closed because we asked or
        // because something upstream gave up; usage is cumulative seconds.
        this.log(
          `gptlive session closed (reason=${event.reason ?? "?"}` +
            (event.usage?.seconds !== undefined
              ? `, seconds=${event.usage.seconds}`
              : "") +
            ")",
        );
        this.closedByServer?.();
        break;

      case GPTLiveServerEvent.SessionUsageUpdated:
        // Cumulative snapshot, not an increment. context_window.usage_ratio
        // is optional and is how an approaching compaction becomes visible.
        this.log(
          `gptlive usage: seconds=${event.usage?.seconds ?? "?"}` +
            (event.context_window?.usage_ratio !== undefined
              ? ` context=${Math.round(event.context_window.usage_ratio * 100)}%`
              : ""),
        );
        break;

      case GPTLiveServerEvent.Error:
        // The whole payload, not just the message: a rejected command's error
        // carries code/param/client_event_id that say WHICH send was wrong.
        this.log(`gptlive error: ${JSON.stringify(event).slice(0, 600)}`);
        this.events.onError(String(event.error?.message ?? "GPT-Live error"));
        break;

      default:
        // The API adds event types without notice; unhandled ones are normal.
        break;
    }
  }

  /** One unwrapped Responses lifecycle event from the delegated backend. */
  private handleResponsesEvent(inner: unknown, delegationId: unknown): void {
    if (!inner || typeof inner !== "object") return;
    const ev = inner as Json;
    switch (ev.type) {
      case ResponsesEvent.OutputItemDone:
        if (ev.item?.type === "function_call") this.handleToolCall(ev.item);
        break;

      case ResponsesEvent.Completed:
      case ResponsesEvent.Failed:
      case ResponsesEvent.Incomplete: {
        // NOT the end of the delegation: after a tool result is returned, the
        // backend continues in a further response. And `response.output` is
        // ALWAYS [] in v3 snapshots — never read pending calls from it.
        const status = ev.response?.status ?? ev.type;
        if (ev.type !== ResponsesEvent.Completed || status !== "completed") {
          // An incomplete/failed delegation is the avatar promising an answer
          // that never comes — surface why (incomplete_details or error).
          this.log(
            `gptlive delegation ${delegationId ?? "?"} response ${status}: ` +
              JSON.stringify(ev.response ?? ev).slice(0, 400),
          );
        } else if (config.gptlive.debug) {
          this.log(`gptlive delegation ${delegationId ?? "?"} response completed`);
        }
        break;
      }

      default:
        break;
    }
  }

  private sendGreeting(): void {
    // From server/prompts/greeting.md. An empty file means "say nothing, let
    // the user speak first".
    // v3 speak-first path per OpenAI's tested example: one fresh
    // `session.instructions.append` (delegation_id null) carrying the
    // speak-now directive AND the opening. Not commentary — that is for
    // information to paraphrase, and the guide measured instructions as the
    // reliable trigger (500/500 sessions spoke first).
    const greeting = DEFAULT_GREETING;
    if (!greeting) return;
    this.append("instructions", GREETING_PREAMBLE + greeting);
  }

  /**
   * Run one completed function_call item and return its result.
   *
   * Every actionable call must get exactly one `response.item.create`
   * function_call_output — without it the call stays pending server-side and
   * BLOCKS every later delegation (confirmed by OpenAI; this was the
   * frozen-delegation bug). So every path out of here sends a result:
   * rendered, failed, or unparseable — the one exception is a missing
   * call_id, which cannot be answered at all.
   *
   * v3: the result alone does nothing. `response.create` must follow, or the
   * backend never resumes and the avatar's spoken half never arrives. With
   * parallel_tool_calls=false there is one call per response, so the pair is
   * sent back to back; enable parallel calls and this must batch instead
   * (function_call_outputs_required otherwise).
   */
  private handleToolCall(item: Json): void {
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    if (!callId) {
      this.log("gptlive tool call missing call_id — cannot return a result");
      return;
    }
    if (this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);

    const name = typeof item.name === "string" && item.name ? item.name : null;
    let result: Record<string, unknown>;
    if (typeof item.arguments === "string" && item.arguments) {
      try {
        const args = JSON.parse(item.arguments) as Record<string, unknown>;
        result = this.events.onToolCall(name, args);
      } catch {
        result = {
          shown: false,
          error: "arguments were not valid JSON; nothing was displayed",
        };
      }
    } else {
      result = { shown: false, error: "no arguments; nothing was displayed" };
    }

    // The result is a free-form string the backend reads as the tool's return
    // value — it continues its reply after response.create.
    this.send(GPTLiveClientEvent.ResponseItemCreate, {
      event_id: `tool_result_${callId}`,
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.send(GPTLiveClientEvent.ResponseCreate, {
      event_id: `continue_${callId}`,
    });
    this.log(
      `gptlive tool result sent (${name ?? "unnamed"} → shown=${result.shown})`,
    );
  }

  private debugEventShape(event: Json): void {
    if (!config.gptlive.debug) return;
    const type = String(event.type ?? "(untyped)");
    // Unwrap the Responses envelope so the inner types get shape-logged too.
    const shapeKey =
      type === GPTLiveServerEvent.ResponseEvent && event.event?.type
        ? `response.event/${event.event.type}`
        : type;
    if (!this.seenEventTypes.has(shapeKey)) {
      this.seenEventTypes.add(shapeKey);
      const inner = type === GPTLiveServerEvent.ResponseEvent ? event.event : event;
      const itemKeys =
        inner?.item && typeof inner.item === "object"
          ? ` item=[${Object.keys(inner.item).sort().join(",")}]`
          : "";
      this.log(
        `gptlive event: ${shapeKey} keys=[${Object.keys(inner ?? {}).sort().join(",")}]${itemKeys}`,
      );
    }
    // Full payloads on demand. Audio deltas are elided — they are megabytes of
    // base64 and their shape was already logged above.
    if (type !== GPTLiveServerEvent.OutputAudioDelta) {
      this.log(`gptlive raw: ${JSON.stringify(event).slice(0, 600)}`);
    }
  }
}
