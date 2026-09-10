# LiveAvatar × GPT-Live — customer support demo

A minimal, readable reference integration: **OpenAI GPT-Live** (a full-duplex
speech-to-speech model) driving a **HeyGen LiveAvatar** — a realtime voice
agent with a face, whose tool calls land on screen as animated panels.

Out of the box it is a **LiveAvatar support agent**: it answers questions
about the product from a markdown knowledge base — pricing, plans, Full mode
versus Avatar Only, latency, limits, integration — and puts the answer on
screen as it speaks. Ask what it costs and the pricing sheet slides in with
the avatar tucked in the corner. Ask about the modes and a two-column
comparison appears. Ask for a refund and it hands you off: a clickable card
with the support address and a pre-filled email drafted from your own words.
Every number on screen comes from the server's tables, never from the model's
memory. The persona is three markdown files (`server/prompts/`) and each
visual is one tool plus one composition — swap those and it is any other
demo.

Barebones on purpose: the wiring is the thing you read, not a framework around
it. Fork it, swap the knowledge base, keep the face.

```
                        ┌────────────────────────┐
                 ws     │      orchestrator      │   ws    ┌──────────────┐
   mic audio ──────────►│       (server/)        │◄───────►│   GPT-Live   │
   transcripts ◄────────│   pricing + modes      │         │  + Responses │
   panels      ◄────────│  audio ──► media server│         │  (tools)     │
                        └───────────────┬────────┘         └──────────────┘
  ┌─────────┐                           │ ws (LITE session)
  │ browser │      LiveKit      ┌───────▼────────┐
  │ (web/)  │◄─────────────────►│   LiveAvatar   │
  └─────────┘  avatar A/V       └────────────────┘
```

The browser never holds an API key. It gets a LiveKit token to watch the
avatar, and a websocket for mic audio (up) and transcripts + visuals (down).
The avatar's voice takes the short path: GPT-Live → orchestrator → media
server, with the browser out of the loop.

## Quickstart

Requirements: Node ≥ 20.12, pnpm, a [LiveAvatar API key](https://app.liveavatar.com),
and an OpenAI API key with GPT-Live access (generally available; this
integration speaks the v3 contract, `gpt-live-1`).

```bash
pnpm install
pnpm run setup   # prompts for the two API keys, verifies each, writes .env
pnpm dev         # server on :8788, web on :5174 (+1 from the language demo, so both run side by side)
```

`pnpm run setup` walks you through it: it asks for each key (with the URL to
create one), verifies it against the live API before accepting it, and writes
`.env` at the repo root. Safe to re-run — existing values are kept and
re-verified, not re-asked. (The `run` matters: bare `pnpm setup` is pnpm's own
built-in command.)

Prefer doing it by hand? `cp .env.example .env` and fill it in. Either way,
`pnpm dev` and `pnpm start` check the required variables before starting and
name exactly what's missing.

No avatar to pick, no prompt to write: a default avatar id ships in
`.env.example` (swap `LIVEAVATAR_AVATAR_ID` for one of your own, or unset it
and the server uses the first public avatar and logs which), and the persona
ships in `server/prompts/`.

Open http://localhost:5174 → **Start** → allow the mic → talk. The agent
greets you and invites a question; behind it, a resting "Ask me anything"
frame with prompt chips fills the screen. Try these:

- **"How much does it cost?"** — the pricing sheet takes the stage, the
  avatar shrinks to the corner, and the agent reads the plans back.
- **"What's the difference between Full mode and Lite mode?"** — two cards
  side by side: what Full mode includes, what Avatar Only leaves to you.
- **"I was charged twice, I want a refund."** — the agent says this needs a
  human and a support card appears bottom-left. Click it: your mail client
  opens with the address, a subject, and your request already written.

To change who the agent is: edit `server/prompts/instructions.md` (persona
and habits) and `server/prompts/greeting.md` (the opening line). To change
what it knows: edit `server/prompts/knowledge.md` — the whole product
reference, appended to both models' instructions. Restart the server. An
empty `greeting.md` means the user speaks first.

## What's on screen, and where the facts come from

| Tool | Widget | Model supplies | Server supplies |
| --- | --- | --- | --- |
| `show_pricing_sheet` | `pricing_sheet` (PiP) | a heading | every plan row + footnote (`PRICING` in `server/src/tools.ts`) |
| `show_mode_comparison` | `mode_comparison` (PiP) | a headline | both columns (`MODES`) |
| `show_support_contact` | `support_contact` (full-frame) | a summary of the ask, optional topic | the address (`SUPPORT_EMAIL`), the mailto |
| `hide_card` | `hide` | a reason | — |

The model asks for a panel; the server fills it. A model that could supply a
price would eventually misquote one, so it can't.

The knowledge base and the pricing table are separate on purpose: the model
speaks from `knowledge.md`, the sheet renders from `tools.ts`. Change a price
in one and you must change it in the other — the two are the same fact in two
formats.

## Troubleshooting a fresh clone

**"Missing required env: …" when you run `pnpm dev`.** The preflight check
(`scripts/check-env.mjs`) refuses to start until the required variables are
set, and names them. Run `pnpm run setup` — it prompts for each key and
verifies it against the live API — or fill in `.env` by hand. The server also
re-checks per session (`/api/session/start` 500s naming what's absent), so a
deployment with broken ambient env explains itself too. The server reads
`.env` only at startup.

**A key that doesn't work.** `pnpm run setup` verifies both keys before saving
them, so a typo or revoked key fails there with a pointer to the right
dashboard — re-run it any time keys change.

**The avatar appears and blinks but never speaks.** LiveAvatar is up; GPT-Live
isn't. Almost always a bad `OPENAI_API_KEY` or no GPT-Live access on the
account. Set `GPT_LIVE_DEBUG=1` and restart to watch every upstream event
(audio elided) — a session that
authenticates but errors will say why.

**Any other error on Start.** Upstream error bodies are passed through
verbatim on purpose — a 401 from LiveAvatar or OpenAI means that key; read the
message, it is the real one.

**It speaks but never hears you.** The status line under the stage says
`microphone unavailable` if permission was denied — re-allow it in the
browser's site settings and Start again. There is no push-to-talk and no VAD:
the mic streams continuously (meter next to the status line) and the model
decides when you're done talking.

**It answered a pricing question out loud but no sheet appeared — then it
did, mid-sentence.** Working as designed. GPT-Live delegates on capability
gaps, not prose, and often answers a pricing question itself without calling
the tool. So the server also watches the *avatar's* transcript: the first time
it is heard saying "credits" or "pricing", the sheet is pushed directly
(`PRICING_PATTERN` in `server/src/session.ts`). Same for the mode comparison
and the support hand-off. Each has a cooldown so a long pricing conversation
doesn't replay the sheet every sentence.

**The support card appeared when nobody asked for support.** The hand-off
watch fires on the avatar *saying* a hand-off — "contact support", "the
support team", the address — not on the user's ask. Read the logged
transcript; if the phrasing is a false positive, narrow `HANDOFF_PATTERN`.
It deliberately does not match the bare word "support", which is in the
greeting.

**A price on screen disagrees with what it said.** The sheet is right
(`tools.ts`); the model spoke from `knowledge.md`. Somebody changed one and
not the other.

**No greeting when the session opens.** An empty `server/prompts/greeting.md`
is a feature, not a bug: it means "say nothing, let the user speak first".

**Port 8788 is taken.** Set `PORT` in `.env` — and mirror it in
`web/vite.config.ts`, whose dev proxy points at `:8788`. (Vite itself moving
off 5174 is fine; the proxy target is the only coupling.)

## What's in the box

| Path | What it is |
| --- | --- |
| `shared/messages.ts` | The wire protocol — every message both sides speak, plus the props of each widget |
| `shared/tools.ts` | The tool registry — the four tools, schema + arg types co-located |
| `server/prompts/instructions.md` | Who the agent is and how it answers |
| `server/prompts/greeting.md` | The opening line |
| `server/prompts/knowledge.md` | Everything it knows about LiveAvatar — the reference material, appended to both models |
| `server/src/prompts.ts` | Loads the persona + knowledge; holds the delegation/tool mechanics prompts |
| `server/src/tools.ts` | Dispatcher: validates calls, holds `PRICING`, `MODES`, `SUPPORT_EMAIL`, builds the mailto |
| `server/src/gptlive.ts` | The GPT-Live v3 bridge: session start, audio, transcripts, tool calls |
| `server/src/turns.ts` | Turn projection over v3 transcript deltas — the API has no turn events |
| `server/src/mediaServer.ts` | The avatar's ear: LITE media-server websocket |
| `server/src/session.ts` | Wires the legs together; owns barge-in and the transcript-watch pushes |
| `web/src/livekitRoom.ts` | Joins the room, attaches the avatar's video + audio |
| `web/src/micCapture.ts` | AudioWorklet → 24kHz PCM16 base64 (no VAD — the model owns turn-taking) |
| `web/src/overlays/` | The single switch over `widget`; one renderer per widget |
| `web/src/overlays/supportContact.ts` | The one widget that is real DOM, not a composition — because it has to be clickable |
| `web/public/overlays/pricing-sheet.html` | The pricing panel composition |
| `web/public/overlays/mode-comparison.html` | The two-column comparison composition |
| `web/public/overlays/home.html` | The resting "Ask me anything" frame that plays when no panel is up |

Deeper docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how and why),
[`AGENTS.md`](AGENTS.md) (a map for coding agents, including the add-a-tool
recipe).

## How tool calls become visuals

1. The live model holds **no tools**. When a visual is wanted it delegates the
   turn to its backend Responses model — which does hold them
   (`shared/tools.ts`).
2. The Responses model answers in words **and** calls e.g.
   `show_pricing_sheet` in the same reply. The words are injected back into
   the live session and spoken; the tool call surfaces on the orchestrator's
   socket. The tool result carries the exact rows placed on screen, so what
   it says next matches what is showing.
3. The orchestrator validates the call (`server/src/tools.ts`), fills in the
   server-owned content, and forwards one `{ type: "ui", widget, props }`
   message to the browser.
4. The browser's widget switch (`web/src/overlays/`) plays the matching
   composition — a transparent animated page layered over the avatar's video.
   Staging is per-widget: the pricing sheet and mode comparison set PiP and
   take the stage; the support card sits bottom-left over the full-frame
   avatar. Every widget also fades the resting home frame out until the screen
   is clear again. Nothing is composited into the stream itself.

**The insurance path.** Step 1 is the weak link: the live model will often
just answer. So `session.ts` also watches the avatar's own transcript and
pushes the pricing sheet, the mode comparison, or the support card through
the same dispatcher when the avatar is heard talking about them — no tool
call involved. The hand-off is the case that matters most: an email address
heard once and never shown is a dead end. Delegation is preferred when it
fires (its spoken reply reads the panel back); the watch is the fallback, and
shared cooldowns keep the two from stacking.

**Why the support card is not a composition.** Compositions play inside the
player's sandboxed iframe with `pointer-events: none` — a `mailto:` in there
is inert. A card whose whole job is to be clicked has to be host-page DOM, so
`supportContact.ts` appends a real anchor to the stage. It has no timeline, so
it stays until the user dismisses it or the next widget replaces it — an
email you haven't sent yet should not evaporate.

Adding a tool is three small edits — see [`AGENTS.md`](AGENTS.md) and
[`docs/ADDING_FRONTEND_COMPONENTS.md`](docs/ADDING_FRONTEND_COMPONENTS.md).
For why a registered tool may still never fire, and the trigger patterns that
do work, see [`docs/MAKING_VISUALS_FIRE.md`](docs/MAKING_VISUALS_FIRE.md).

## Iterating on panels

Render a widget without burning session minutes — from the browser console:

```js
window.__ui({
  widget: "pricing_sheet",
  props: {
    title: "LiveAvatar pricing",
    rows: [
      { plan: "Free", price: "$0 / mo", detail: "10 credits, 2 min sessions" },
      { plan: "Starter", price: "$19 / mo", detail: "200 credits, 5 min sessions" },
    ],
    footnote: "1 credit = 30s Full / 1 min Lite",
  },
})

window.__ui({
  widget: "support_contact",
  props: {
    title: "Talk to a human",
    email: "support@liveavatar.com",
    note: "This one needs a human. Click the card to open a pre-filled email.",
    subject: "Refund request",
    body: "I was charged twice for the Essential plan in March.",
  },
})

window.__ui({ widget: "hide", props: {} })
window.__home()   // the resting frame, without an avatar
```

The mode comparison takes the full `ModeComparisonProps` shape from
`shared/messages.ts`; the easiest source of a valid one is the `MODES` table
in `server/src/tools.ts`.

## Production notes

This is a starter, not a deployment. Before exposing it publicly: add auth on
`/api/session/start` and the websocket upgrade, hide upstream error bodies,
and read the hardening list in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#production-hardening).

## License

MIT. One vendored exception: the bundled GSAP
(`web/public/overlays/vendor/gsap.min.js`) stays under its own
[GSAP Standard License](https://gsap.com/standard-license) — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
