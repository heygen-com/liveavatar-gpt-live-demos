# Architecture

Why the pieces are shaped the way they are. The code carries the fine detail
in comments; this is the map.

## The problem

GPT-Live is **full-duplex**: one continuous audio stream each way, and the
model manages turn-taking itself — it interrupts, barges in, yields, and emits
partial transcripts as it speaks. LiveAvatar's session protocol is
**turn-based** at heart (`speak` / `speak_end` / `interrupt`).

Instead of manufacturing turn boundaries to bridge them, this integration
treats the avatar as a pure **audio → face renderer** fed one never-ending
utterance:

- every GPT-Live audio chunk is appended to the avatar's buffer as it arrives,
  in order — v3 audio deltas carry no timeline, so arrival IS the timing;
- no per-turn `speak_end`, no per-turn interrupt. The model yields on its own;
  when it goes quiet the stream simply stops and the avatar idles.

## The three websockets

```
browser ──► POST /api/session/start ──► LiveAvatar /v1/sessions/token + /start   (server-side)
browser ◄── LiveKit room                                    (avatar audio + video)
browser ◄─► /ws/{session_id}                     (mic up; turns + visuals down)
server  ◄─► wss://api.openai.com/v1/live/sessions              (GPT-Live v3)
server  ──► LITE media-server ws_url              (avatar's ear: audio buffer)
```

A **LITE** session is the key: started bare (no agent config), it returns
`livekit_url` + `livekit_client_token` (for the browser to watch) **and**
`ws_url` — a direct websocket into the avatar's media server, which is what
lets this server thread GPT-Live's audio in without the browser in the loop.
The protocol over it is public and small
([docs](https://docs.liveavatar.com/docs/lite-mode/events.md)): `agent.speak`
(PCM16 24kHz base64 chunks), `agent.interrupt`, `session.keep_alive` — and one
rule that matters: commands sent before the server reports
`session.state_updated: "connected"` are silently dropped, which is why the
GPT-Live leg is gated on that event (a lost greeting is the symptom).

The browser never holds a key or a session token. Avatar audio deliberately
does not travel on the browser websocket — it reaches the browser over
LiveKit, already lip-synced to the video.

## Audio timing (v3)

v2 stamped every audio delta with `start_ms`/`end_ms` and omitted the silence
between utterances; the bridge used to reconstruct that quiet so the mouth
would not run ahead of the voice. **v3 removed the timeline fields** — the
contract is "decode chunks and play them in order" — so there is nothing to
reconstruct from and the chunks are forwarded as they arrive. Whether Diamond
streams its pauses inline or still omits them is something to watch on burst
delivery; if lip-sync drifts, the only remaining timing signal is
`start_ms`/`end_ms` on the *transcript* deltas.

## Turn projection (`server/src/turns.ts`)

v3 emits no turn events — only `session.input_transcript.delta` and
`session.output_transcript.delta`, 200ms frames with text and session-timeline
`start_ms`/`end_ms`, empty frames omitted. Everything downstream wants turns
(the transcript UI, the table pushes, the deal fallback, the barge-in
watch), so the bridge projects them: same-speaker fragments join one turn; a
turn closes when the speaker has been quiet for `TURN_GAP_MS` (1.5s) — on the
session timeline for bursty delivery, on the wall clock for the final fragment
that nothing follows. User and assistant turns overlap freely (full-duplex).
A user turn *opening* is the only "the user started talking" signal the API
gives; it arrives once GPT-Live has heard words, which is slower than a
loudness threshold but immune to door slams and the avatar's own voice.

## Tool calls → overlays

Two models cooperate:

- The **live model** speaks. It holds no tools — it is told it *cannot* draw
  on screen and must delegate the turn to its backend when a visual is wanted
  (and never to claim one is showing).
- The **Responses model** answers delegated turns. It holds the tools
  (`shared/tools.ts`) and is told every reply must carry the spoken answer AND
  the tool call in the same reply — a tool-only reply leaves the avatar silent
  while the live voice waits.

A finished call is validated server-side and forwarded as one
`{ type: "ui", widget, props }` message. The browser renders it with a single
switch over `widget` — a transparent
[Hyperframes](https://hyperframes.heygen.com) composition (a self-contained
animated HTML page) layered over the avatar's video. Nothing is composited
into the stream; the video is untouched underneath. To add a widget of your
own, follow [ADDING_FRONTEND_COMPONENTS.md](ADDING_FRONTEND_COMPONENTS.md);
for why a registered tool may still never fire — and the trigger patterns
that work — see [MAKING_VISUALS_FIRE.md](MAKING_VISUALS_FIRE.md).

**Staging is per-widget and client-decided — never a model argument.** A
`term_card` is a lower-third over the full-frame avatar; `learned_words` sets
`data-pip` on the stage, shrinking the avatar to the bottom-right corner while
the recap panel is up. Keeping layout out of the tool schema keeps the model
from arguing with the product about staging, and keeps the schema down to the
content.

### How the backend model speaks (the follow-up mechanism)

The Responses model's reply **text** is automatically injected into the live
session by the service and voiced by the realtime model — that is the built-in
path for "the backend tells the realtime model what to say" alongside a tool
call, and why `RESPONSES_INSTRUCTIONS` insists every reply carries the spoken
answer AND the tool call in the same reply. The orchestrator must NOT replay
that text itself (it would be spoken twice), and must answer **every** tool
call with a `response.item.create` (`function_call_output`) **followed by
`response.create`** — v3 buffers results until that explicit continue, and an
unanswered call stays pending and blocks every later delegation, so even
invalid calls get an error result (`onToolCall` in session.ts). The backend
CONTINUES its reply after the continue, which is what synchronizes speech with screen: the
recap flow is tool fires → server renders the panel from its own word store →
the result hands back the exact words on it → the model's continued reply
walks through those words as the avatar's voice.

### The learned-words store

Every `term_card` shown is recorded server-side on the session (deduped by
term, in teaching order). `show_learned_words` renders **from that store** —
the model asks for the recap and supplies only the heading, so it cannot
misremember, invent, or drop words. State lives exactly as long as the session
does.

### API shapes the bridge absorbs (v3)

- Every Responses lifecycle event arrives wrapped: `response.event` with the
  inner event in `event` and the delegation in `delegation_id`. Tool calls are
  driven from the inner `response.output_item.done` only — its twin
  `response.function_call_arguments.done` arrives first without `call_id` or
  `name`. Calls are deduped by `call_id`; `inferToolName` stays as a fallback
  for a name-less item, which is why every tool keeps a distinct set of
  required parameter names.
- Lifecycle snapshots are reduced: `response.completed.response.output` is
  always `[]`. Never read pending calls from it.
- `response.create` exists but is a *backend* command (start/continue
  delegated work); it never starts a voice turn. The opening greeting is a
  `session.instructions.append` with a speak-first directive — OpenAI's tested
  path. The three appends (`instructions` / `commentary` / `thinking`) take a
  plain string and a required, nullable `delegation_id`.
- Custom voices (`voice_…`) must be sent as `{ id }`; bare strings are
  reserved for the named voices.
- Audio deltas outgrow default websocket frame caps; the bridge raises
  `maxPayload`.

## Barge-in (`server/src/session.ts`)

Audio arrives faster than it plays, so the media server can be holding several
seconds of speech the model has already abandoned — when the user talks over
the avatar, that queue is what keeps talking.

But not every user turn is an interruption: a "mm-hmm" is a backchannel, and
the model talks through it. Clearing on the turn alone cuts the avatar off
mid-sentence — and since GPT-Live believes it already said the rest, it never
comes back. So a user turn only **starts a watch**; after a grace period the
buffer is cleared only if the model has actually stopped producing audio
(quiet ≥ 350ms and ≤ 6s — past that, nothing is left playing). The browser is
told (`interrupted`) so the transcript can reflect that the rest of the
sentence was never heard.

## Why not the LiveAvatar web SDK?

The first question every HeyGen-aware developer asks. Two reasons, neither of
which is tool calling:

1. **Session ownership.** The SDK assumes the browser holds the session token
   and calls `start()` itself. Here the *server* must call
   `/v1/sessions/start` — that response is the only place the media-server
   `ws_url` comes back, and the audio leg cannot exist without it.
2. **It would duplicate the transport.** After the server-side start, the
   browser only needs to join a LiveKit room and attach two tracks — ~50 lines
   of `livekit-client`.

Tool calling never touches LiveAvatar at all: LiveAvatar LITE is a pure
audio-to-face renderer with no LLM layer, and the tool path (GPT-Live
delegation → orchestrator → browser overlay) is exactly the gap this starter
fills. If you prefer a browser-driven integration, the SDK works fine — feed
it GPT-Live audio via `speakAudioChunk()` — at the cost of routing the voice
through the browser.

## Session lifecycle

- Sessions are billable from `/start` and live in one process's memory —
  a restart drops them (they are stopped upstream on the way out).
- Whichever leg (GPT-Live / media server) exits first ends the session:
  a one-legged session is a bill with nobody listening.
- The browser disconnecting ends the session immediately; a 60s idle timeout
  (no mic frames — mic audio is the only liveness signal) and a 10-minute max
  duration are the backstops.
- Teardown order matters: GPT-Live gets `session.close` first and its drain
  still delivers the last words into the media leg before that closes.

## Production hardening

Deliberately left out of the starter, in rough priority order:

1. **Auth.** Gate `/api/session/start` behind your login, and hand the browser
   a short-lived credential for the websocket upgrade (production uses an
   HMAC ticket: signed server-side, scoped to one session id, valid ~60s).
2. **Hide upstream error bodies** from the public response — verbatim
   LiveAvatar errors tell a prober about your credit and concurrency limits.
3. **Browser-side ducking**: drop the avatar's playback volume the moment the
   local mic gets loud, before the server-side interrupt confirms — reversible
   response to an uncertain signal, makes barge-in feel instant.
4. **Audible-time scheduling**: transcripts arrive seconds ahead of the
   avatar's voice. Anything that must land when words are *heard* (synced
   captions, timed visuals) needs the playback-position estimate, not arrival
   time.
5. **Observability**: per-session structured logs, delegation latency timing,
   context-utilization warnings from `session.usage.updated`
   (`context_window.usage_ratio`).
6. Multi-pod session routing, reconnect/resume paths, rate limiting.
