# LiveAvatar × GPT-Live — poker coach demo

A minimal, readable reference integration: **OpenAI GPT-Live** (a full-duplex
speech-to-speech model) driving a **HeyGen LiveAvatar** — a realtime voice
agent with a face, whose tool calls move a game on screen.

Out of the box it is **Ace, a heads-up poker coach**: it deals you no-limit
hold'em hands against a simulated opponent, both a hundred big blinds deep,
and makes you think out loud at every decision. The table — your cards, the
board, the pot, stacks, the running score — is rendered from the server's own
game simulator, never from the model's memory. You say "raise to three big
blinds"; the model relays that to the table; the table decides what happens;
the model narrates the result. The persona is two markdown files
(`server/prompts/`); the game lives in one file (`server/src/poker.ts`).

Barebones on purpose: the wiring is the thing you read, not a framework around
it. Fork it, swap the game, keep the face.

```
                        ┌────────────────────────┐
                 ws     │      orchestrator      │   ws    ┌──────────────┐
   mic audio ──────────►│       (server/)        │◄───────►│   GPT-Live   │
   transcripts ◄────────│   poker simulator      │         │  + Responses │
   table state ◄────────│  audio ──► media server│         │  (tools)     │
                        └───────────────┬────────┘         └──────────────┘
  ┌─────────┐                           │ ws (LITE session)
  │ browser │      LiveKit      ┌───────▼────────┐
  │ (web/)  │◄─────────────────►│   LiveAvatar   │
  └─────────┘  avatar A/V       └────────────────┘
```

The browser never holds an API key. It gets a LiveKit token to watch the
avatar, and a websocket for mic audio (up) and transcripts + table state
(down). The avatar's voice takes the short path: GPT-Live → orchestrator →
media server, with the browser out of the loop.

## Quickstart

Requirements: Node ≥ 20.12, pnpm, a [LiveAvatar API key](https://app.liveavatar.com),
and an OpenAI API key with GPT-Live access (generally available; this
integration speaks the v3 contract, `gpt-live-1`).

```bash
pnpm install
pnpm run setup   # prompts for the two API keys, verifies each, writes .env
pnpm dev         # server on :8789, web on :5175 (+2 from the language demo, so both run side by side)
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

Open http://localhost:5175 → **Start** → allow the mic → talk. Ace greets you,
explains the drill, and asks if you're ready. Say yes: the table slides in,
the avatar shrinks to the corner, your two hole cards land face-up, and Ace
asks what you want to do. Talk through it, then commit — "call", "raise to
three big blinds", "fold". The opponent responds, the next street deals, and
the coaching continues to showdown. After the hand: one takeaway, then the
offer of another.

To change who the coach is: edit `server/prompts/instructions.md` (persona and
coaching style) and `server/prompts/greeting.md` (the opening line), restart
the server. An empty `greeting.md` means the user speaks first. To change what
the game is, see [Repurposing](#repurposing) below.

## How a hand plays

The simulator (`server/src/poker.ts`) is deliberately small for v1:

- **Heads-up no-limit hold'em, 100bb each, every hand.** A running score
  (`scoreBb`) carries wins and losses across hands.
- **You are always the big blind** and act on every street after the
  opponent's forced opener — so every decision point in a hand is yours,
  which is the whole coaching loop.
- **The opponent is a probabilistic bot** that never re-raises and never looks
  at its own cards. A coaching demo needs streets and showdowns, not a good
  villain — and a bot that ignores its hand can never leak it through its
  behavior.
- **One raise per street.** After you bet or raise, the bot calls or folds and
  the street closes.
- **Showdown reveals the opponent's cards** — until then they never cross the
  wire to the browser. Face-down backs are the composition's default.

The model has two tools and neither carries game state:

| Tool | Fires when | Does |
| --- | --- | --- |
| `deal_next_hand` | You ask to play / deal / next hand, between hands | Shuffles, posts blinds, pushes your cards to the table |
| `player_action` | You commit to bet / raise / check / call / fold | Applies it, runs the opponent, deals the next street or settles the hand |

Both return exactly what happened (opponent's response, new cards, pot, whose
action) and the model narrates **that**. Every table change also drops a
`[GAME STATE]` line into the live model's silent context, so the voice you
hear knows the real board even on turns that never touched a tool.

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

**You said "deal" and nothing happened — then a hand appeared a few seconds
later.** Working as designed. Delegation on "ready?" / "yes" is marginal, so
the server arms a fallback when a finished user turn sounds like a request for
a hand and none is live: if no `deal_next_hand` lands in time, it deals
directly and instructs the model to read the hand out
(`server/src/session.ts`, `DEAL_INTENT`). Tune the regex or the timeout
there; don't bypass the delegation path.

**Ace talks about a card that isn't on the table.** The table is right; the
model misremembered. That's the failure mode the design exists to contain —
the visual and the `[GAME STATE]` context both come from the simulator. If it
happens often, check that `player_action` results are actually reaching the
model (`GPT_LIVE_DEBUG=1`) rather than loosening the prompts.

**No greeting when the session opens.** An empty `server/prompts/greeting.md`
is a feature, not a bug: it means "say nothing, let the user speak first".

**Port 8789 is taken.** Set `PORT` in `.env` — and mirror it in
`web/vite.config.ts`, whose dev proxy points at `:8789`. (Vite itself moving
off 5175 is fine; the proxy target is the only coupling.)

## What's in the box

| Path | What it is |
| --- | --- |
| `shared/messages.ts` | The wire protocol — every message both sides speak, including `PokerTableProps` |
| `shared/tools.ts` | The tool registry — `player_action` and `deal_next_hand`, schema + arg types co-located |
| `server/prompts/*.md` | The persona — edit these to change who the coach is |
| `server/src/poker.ts` | The heads-up simulator — deck, 7-card evaluator, opponent bot; the single source of game truth |
| `server/src/prompts.ts` | Loads the persona; holds the game-loop directives and delegation/tool mechanics prompts |
| `server/src/gptlive.ts` | The GPT-Live v3 bridge: session start, audio, transcripts, tool calls |
| `server/src/turns.ts` | Turn projection over v3 transcript deltas — the API has no turn events |
| `server/src/mediaServer.ts` | The avatar's ear: LITE media-server websocket |
| `server/src/session.ts` | Wires the legs together; owns barge-in, tool dispatch, the deal fallback |
| `web/src/livekitRoom.ts` | Joins the room, attaches the avatar's video + audio |
| `web/src/micCapture.ts` | AudioWorklet → 24kHz PCM16 base64 (no VAD — the model owns turn-taking) |
| `web/src/overlays/` | The single switch over `widget`; `pokerTable.ts` renders the table |
| `web/public/overlays/poker-table.html` | The table composition (a self-contained animated page) |

Deeper docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how and why),
[`AGENTS.md`](AGENTS.md) (a map for coding agents, including the invariants
not to "fix").

## How tool calls become the table

1. The live model holds **no tools**. When you commit to an action or ask for
   a hand, it delegates the turn to its backend Responses model — which does
   hold them (`shared/tools.ts`). Thinking out loud is coached by the live
   model directly and never delegated; only a committed decision reaches the
   table.
2. The Responses model answers in words **and** calls `player_action` (or
   `deal_next_hand`) in the same reply. The words are injected back into the
   live session and spoken; the tool call surfaces on the orchestrator's
   socket.
3. The orchestrator validates the call (`server/src/tools.ts`), applies it to
   the simulator, and forwards one `{ type: "ui", widget: "poker_table",
   props }` message to the browser carrying the **whole** table state. The
   `reveal` field names what animates (`new_hand`, `flop`, `turn`, `river`,
   `opponent`, `update`). The tool result — what actually happened — goes back
   to the model to narrate.
4. The browser's widget switch (`web/src/overlays/`) plays the table
   composition — a transparent animated page layered over the avatar's video
   — and sets the stage to PiP, parking the avatar bottom-right. Staging is
   per-widget and client-decided, never a tool argument. Nothing is composited
   into the stream itself.

## Iterating on the table

Render the table without burning session minutes — from the browser console:

```js
window.__ui({
  widget: "poker_table",
  props: {
    handNumber: 1,
    playerHand: ["As", "Kd"],
    board: ["Qh", "Jc", "2s"],
    opponentHand: null,
    potBb: 7,
    playerStackBb: 96.5,
    opponentStackBb: 96.5,
    toCallBb: 0,
    scoreBb: 0,
    statusText: "Opponent checks. Your action.",
    reveal: "flop",
  },
})
window.__ui({ widget: "hide", props: {} })
```

Cards are rank + suit (`As`, `Td`, `3h`). Pass `opponentHand` as a pair with
`reveal: "opponent"` to see the showdown flip.

## Repurposing

`server/prompts/*.md` re-skins the coach only. The poker domain lives in code
and is yours to replace: the simulator (`server/src/poker.ts`), the game-loop
directives in `server/src/prompts.ts`, the deal fallback in
`server/src/session.ts`, the two tools and their required-key sets
(`["action"]`, `["ready"]`) in `shared/tools.ts`, and the table composition.
[`docs/REPURPOSING.md`](docs/REPURPOSING.md) names the hooks; the add-a-visual
walkthrough is [`docs/ADDING_FRONTEND_COMPONENTS.md`](docs/ADDING_FRONTEND_COMPONENTS.md);
why a registered tool may never fire, and the trigger patterns that work, is
[`docs/MAKING_VISUALS_FIRE.md`](docs/MAKING_VISUALS_FIRE.md).

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
