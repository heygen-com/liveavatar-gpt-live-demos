# AGENTS.md

Operational map for coding agents (and fast-moving humans). Product overview
lives in [README.md](README.md); design rationale in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Shape

pnpm workspace, TypeScript everywhere, deliberately few dependencies.

```
shared/     The contract. messages.ts (wire protocol) + tools.ts (tool registry).
            NOT a package — both sides import it by relative path.
server/     Orchestrator. Node + ws only. `pnpm dev` = tsx watch.
            prompts/*.md is the persona (Japanese tutor by default) — the
            intended customization point. src/prompts.ts loads it and holds the
            non-negotiable delegation/tool mechanics prompts.
web/        Browser client. Vite + livekit-client + @hyperframes/player.
```

`pnpm dev` at the root runs both. Vite (:5174) proxies `/api` and `/ws` to the
server (:8788), so the browser sees one origin. (A port up from the
language-tutor demo on 5173/8787, so both can run at once.) Config is one
`.env` at the repo root (see `.env.example`); only the server reads it.

## Commands

```bash
pnpm install
pnpm run setup    # interactive: collects + live-verifies API keys, writes .env
pnpm dev          # both processes (preflights required env via scripts/check-env.mjs)
pnpm typecheck    # tsc --noEmit in server and web (both include ../shared)
pnpm build        # web/dist — the server serves it in production
```

`pnpm run setup`, not `pnpm setup` — the bare form is pnpm's own built-in.
`dev`/`start` fail fast through `scripts/check-env.mjs` when required vars are
missing; its required list mirrors `missingConfig()` in `server/src/config.ts`
— change one, change both.

## Invariants — do not "fix" these

- **One continuous utterance.** The avatar never gets a per-turn `speak_end`
  or interrupt. GPT-Live owns turn-taking; the orchestrator only moves audio,
  in arrival order. (v3 audio deltas carry no timeline, so there is nothing to
  reconstruct silence from — the wall clock is the only timing.)
- **Turns are projected, not received.** v3 has no turn events, only timed
  transcript deltas. `server/src/turns.ts` groups them per speaker with a gap
  timeout (`TURN_GAP_MS`). A user turn *opening* there is the barge-in signal;
  an assistant turn *closing* is the turn-boundary hook. Tune the gap, don't
  bypass the projector.
- **No VAD in the browser.** `micCapture.ts` streams every frame, silence
  included. Turn detection belongs to the model, which hears the same audio
  with the conversation as context.
- **Barge-in is two-step.** A user turn opening only *starts a watch*
  (`session.ts`); the buffer is cleared only if the model actually stops
  producing audio. Acting on the turn alone cuts the avatar off on every
  "mm-hmm" — and the model, believing it said the rest, never repeats it.
- **Every tool call gets a result AND a continue** (`gptlive.ts`). Tool calls
  are driven only from the nested `response.output_item.done` (the one event
  carrying `call_id`), deduped by `call_id`, answered with
  `response.item.create`, then resumed with `response.create` — the result
  alone does nothing in v3, and an unanswered call blocks every later
  delegation. Tools in `shared/tools.ts` still keep a **distinct set of
  required parameter names** so `inferToolName` can recover a name-less call
  (`server/src/tools.ts`) should the API ever send one.
- **The greeting is gated on the media socket** (`session.ts`). Audio sent
  before the media leg is up is dropped with no replay; start GPT-Live early
  and the avatar's opening line is silently lost. The greeting itself is a
  `session.instructions.append` (OpenAI's tested speak-first path), not
  commentary.
- **Append kinds mean what v3 says they mean** (`bridge.append`).
  `instructions` = directive to follow; `commentary` = information to SAY;
  `thinking` = silent context. v2's silent "commentary" channel is v3
  `thinking` — mapping by the word speaks progress text aloud.
- **Model output is untrusted.** The dispatcher clamps it
  (`server/src/tools.ts`); compositions render it with `textContent` only.
- **Staging is per-widget, client-decided** (`web/src/overlays/index.ts`) —
  never a tool argument. The pricing sheet and the mode comparison set PiP;
  the support card does not.
- **Facts are server state, not tool arguments.** `PRICING`, `MODES`, and
  `SUPPORT_EMAIL` live in `server/src/tools.ts`; the model asks for a panel
  and supplies only a heading, then reads the numbers back off its tool
  result. Let it supply a price or a capability and it will misquote one.
  Spoken knowledge mirrors these in `server/prompts/knowledge.md` — change a
  fact in both.
- **Both models get the same knowledge** (`server/prompts/knowledge.md`,
  wired in `prompts.ts` + `gptlive.ts`). The live model answers most turns;
  the delegated Responses model answers the ones with visuals. A fact only
  one of them holds is a fact the other invents.
- **The support card is not a composition.** It is host-page DOM
  (`web/src/overlays/supportContact.ts`) because it has to be clickable: the
  player's iframe is sandboxed `allow-scripts allow-same-origin` — no popups,
  no top-level navigation, so a `mailto:` inside it is inert — and
  `#overlay-player` is `pointer-events: none`. It also has no timeline, so it
  never self-clears; `hideAll` has to clear both kinds of widget.

## Recipe: add a front-end component

Full walkthrough — the Hyperframes composition contract and every hook
(`shared/tools.ts` → `server/src/tools.ts` → `shared/messages.ts` →
`web/src/overlays/`) — lives in
[docs/ADDING_FRONTEND_COMPONENTS.md](docs/ADDING_FRONTEND_COMPONENTS.md).
Follow it; the invariants above are restated there in context.

Callable ≠ called: a registered tool that never fires in a live session is
the expected failure, not a wiring bug — GPT-Live delegates on capability
gaps, not prose. The trigger patterns that actually work (server-side
transcript push, prod + fallback, explicit-request directives) and the
debugging ladder live in
[docs/MAKING_VISUALS_FIRE.md](docs/MAKING_VISUALS_FIRE.md).

Test without a session: `window.__ui({ widget: ..., props: ... })` in the
browser console.

## Repurposing (new persona / domain)

`server/prompts/*.md` re-skins the persona only. The tutor's domain logic —
lesson script, recap machinery, tool prompts, the taken tool-key sets, the
ephemeral-composition assumption — lives in code and is the adopter's to
replace: [docs/REPURPOSING.md](docs/REPURPOSING.md) is the excavation list.

## Env

Required: `LIVEAVATAR_API_KEY`, `OPENAI_API_KEY`. GPT-Live is generally
available; `GPT_LIVE_MODEL` defaults to `gpt-live-1` (`server/src/config.ts`).
Missing vars warn at boot and fail `/api/session/start` with a message naming
them.

`LIVEAVATAR_AVATAR_ID` is optional: `.env.example` (and `pnpm run setup`) ship
a default id; unset, the server picks the first active public avatar
(`GET /v1/avatars/public`, no auth) and logs which.

The persona is NOT env config: it lives in `server/prompts/*.md` (hardcoded
fallbacks in `src/prompts.ts` only cover a deleted file). An empty
`greeting.md` means "say nothing, let the user speak first".

## Gotchas

- The session is billable from `/api/session/start`. Every teardown path must
  reach `stopSession` — the registry watchdog (60s idle) is the backstop, not
  the plan. Max duration is enforced upstream by the account's plan, not here.
- `stopSession` claims via Map delete, so racing stops are idempotent.
- One browser per session: the second websocket for the same id is rejected.
- Media-server readiness means the server said `session.state_updated:
  "connected"` — NOT that the socket opened. Commands sent before that are
  silently dropped (documented), which is how a greeting goes missing.
- GPT-Live v3 reference: the OpenAI alpha kit (`docs/api/gpt_live_api_alpha.md`,
  `docs/api/bidi.v3.md`, `gpt-live-v2-to-v3/SKILL.md`). Event names, the
  `response.event` envelope and the result+continue tool loop all come from
  there; don't reintroduce v2 shapes (`turn.*`, `output_audio.delta.audio`,
  `delegation.function_call_output.create`, `channel:`).
- LITE protocol reference: https://docs.liveavatar.com/docs/lite-mode/events.md
  — `agent.speak` / `agent.interrupt` / `session.keep_alive` are the public
  contract; don't invent event fields beyond it.
