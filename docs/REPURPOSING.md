# Repurposing the Demo

This starter ships as a heads-up poker coach, and swapping the domain — a
different game, a support agent, a sales rep, a museum docent — is the
intended use. But "edit `server/prompts/*.md` and restart" only re-skins the
*persona*. Four areas of deliberate, domain-specific behavior live in code,
and **they are yours to address when you repurpose** — they are design
decisions of the poker demo, not bugs, and no generic mechanism replaces them.

(The fifth and biggest repurposing question — why your new visuals don't
appear in live sessions — has its own doc:
[MAKING_VISUALS_FIRE.md](MAKING_VISUALS_FIRE.md). Read it first.)

## 1. Poker logic lives outside `prompts/*.md` — the excavation list

Editing only the markdown persona gets you a support avatar that *tries to
deal you a hand*. The game is wired into the mechanics layer in these places;
rewrite or remove each one for a new domain:

| Where | What |
| --- | --- |
| `server/src/poker.ts` | The simulator: deck, 7-card evaluator, opponent bot, `PokerGame`. The whole file is domain. For a non-game domain, delete it; for a different game, this is the file you rewrite. |
| `server/src/prompts.ts` → `LIVE_DIRECTIVE` | Tells the live model *when* to delegate: "the player commits to an action" or "asks for a hand". Keep the structural clauses (delegate on explicit user requests, never pause, never go silent); replace the trigger shapes with your domain's. |
| `server/src/prompts.ts` → `RESPONSES_INSTRUCTIONS` | Hardcodes "You are the dealer-side brain of a live heads-up poker coach" plus the player_action / deal_next_hand behavioral rules and "narrate the tool result, never guess". Keep the load-bearing first clause (speech + tool in the same reply); replace the domain ones. |
| `server/src/prompts.ts` → `GAME_DIRECTIVE` | The game loop — 100bb, player is the big blind, deal → streets → showdown → takeaway — appended to the live model's instructions **unconditionally** at startup (`gptlive.ts`). Remove, or replace with your domain's flow. Also defines the `[GAME STATE]` contract (see §4). |
| `server/src/prompts.ts` → `SILENCE_CHECKIN`, `DEAL_FALLBACK_PROMPT` | Poker-flavored ("restate what they are facing in the hand"). The silence check-in mechanism is worth keeping — reword it. The deal-fallback prompt goes with the fallback below. |
| `server/src/session.ts` → `DEAL_INTENT`, `dealFallback`, `DEAL_DELEGATION_TIMEOUT_MS` | Watches finished *user* turns for "deal / ready / yes" while no hand is live; if no `deal_next_hand` delegation lands in 8s, the server deals directly and appends an instruction to read the hand out. Remove with the game — but note it is the reference implementation of the "prod + fallback" trigger pattern in MAKING_VISUALS_FIRE.md, and any domain with a "start the thing" moment the model may under-delegate wants the same shape. |
| `server/src/session.ts` → `onToolCall` | The dispatcher. Both cases are poker: they call into `this.game` and return `{ ok, happened, state }`. Replace the cases; keep the shape (every call returns a result object, errors included — an unanswered call blocks every later delegation). |
| `server/src/session.ts` → `pushTable` | The shared tail of every game move: emits the whole table as a `ui` message and appends `[GAME STATE] …` to the live model as `thinking`. The pattern is domain-independent (see §4); the payload is not. |
| `server/src/tools.ts` → `parsePlayerAction`, `tableUi` | Normalizes the model's verb/size into engine values and builds the `poker_table` props from the simulator's snapshot. Delete with the game; write the equivalent clamp-and-render layer for your tools. |
| `web/src/overlays/pokerTable.ts`, `web/public/overlays/poker-table.html` | The table widget and composition. Delete, and drop `poker_table` from the `UiMessage` union in `shared/messages.ts`. |

`pnpm typecheck` catches the removals that break types (deleting a widget
from the `UiMessage` union flags its render sites; deleting `PokerGame` flags
every `this.game` call); it cannot catch leftover prompt text, so grep
`prompts.ts` and `server/prompts/*.md` for poker vocabulary when you're done —
"hand", "deal", "big blind", "table", "player".

## 2. Tool naming: the required-key sets already taken

Every tool's `required` array must be distinct — it is how a name-less tool
call is recovered (`inferToolName`, see the invariant in
[ADDING_FRONTEND_COMPONENTS.md](ADDING_FRONTEND_COMPONENTS.md#2-sharedtoolsts--register-the-tool-the-model-calls)).
Nothing enforces this; a collision is silent and probabilistic — the
name-less finalize event routes to the wrong tool, and the wrong widget (or
none) renders.

Currently taken: `["action"]` (`player_action`) and `["ready"]`
(`deal_next_hand`). Both are generic enough to collide with a new domain
immediately — a `submit_form { action }` is indistinguishable from
`player_action`, a `start_quiz { ready }` from `deal_next_hand`. Before
writing a schema, list every tool's `required` set and pick something disjoint
(`["plan"]`, `["contact_channel"]`, `["term"]`, …). If you delete the poker
tools, their key sets free up.

Note also that `deal_next_hand`'s only parameter is a boolean that is always
true. That is deliberate: a tool with an empty schema has no arguments to
recover its name from. Any "start the thing" tool you add needs at least one
required key for the same reason.

## 3. Compositions are ephemeral broadcast graphics — not interactive UI

The composition contract assumes a graphic that plays and leaves: fixed
`data-duration`, timeline pinned to it, player `ended` → overlay cleared. The
page runs in a sandboxed iframe with no click plumbing.

The poker table is the "persistent" case handled inside that contract: its
`data-duration` is an hour, so `ended` never fires in practice, and every
game move *replaces* the composition with a fresh render of the whole state
(`reveal` names what animates). That works because the table is display-only
— the player acts by speaking, never by clicking.

A genuinely interactive element — a contact card with a clickable `mailto:`,
a button, a form — fights the contract. Options, honest about their cost:

- **Long duration + replace-on-change** (what the table does). Persistent,
  animated, still not clickable.
- **Long duration + a `hide` tool.** The model (or a server push) takes it
  down. Still not clickable; the exit animation beat is lost.
- **Render it in the host page, not the player.** For interactive UI, add a
  plain DOM overlay in `web/` (the renderer module receives the stage element
  via `OverlayContext`) and skip the composition entirely — the
  widget/renderer pipeline doesn't require the player. You own its show/hide
  lifecycle; the player's `ended`-clears-it convention no longer applies, and
  `hideAll` must clear both kinds.
- Keep compositions for what they're good at — animated, timed, on-brand
  moments — and put buttons in the page.

## 4. Server-owned data: the model supplies selectors, never data

The rule (see the game-state invariant in [AGENTS.md](../AGENTS.md)): **if
the model supplies the strings, the avatar will eventually show a hallucinated
one to a user.** Cards, prices, contact channels, account facts — the
dispatcher's clamps limit length, not truth.

The demo's server-owned store is `PokerGame`, held on the session
(`this.game`). The pattern is worth copying whole:

1. **The tool schema carries only what the model may legitimately choose.**
   `player_action` takes a verb and an optional size — the player's decision,
   relayed. It cannot name a card.
2. **The dispatch case reads from and writes to the store**, never from the
   args beyond that choice. `onToolCall` calls `this.game.act(...)` and
   renders the *store's* snapshot.
3. **The tool result hands the truth back.** `{ happened, state }` is what the
   Responses model narrates; its instructions say so explicitly.
4. **Every store change is also pushed to the live model as `thinking`**
   (`pushTable` → `[GAME STATE] …`). The live model coaches *between*
   delegations, from memory — this keeps that memory honest. `thinking`, not
   `commentary`: in v3, commentary is spoken aloud.
5. **The live model's instructions name the contract** (`GAME_DIRECTIVE`:
   "lines marked [GAME STATE] are ground truth — trust them over your
   memory").

For a pricing table or a support directory the store is static rather than a
simulator, but the seam is the same: state on the session, selectors in the
schema, render from the store, result back to the model, silent context
append on change.

## Not on this list

Barge-in, the greeting gate, teardown, tool-call dedupe and the
result+continue loop — the invariants in [AGENTS.md](../AGENTS.md) are
domain-independent and survive any repurposing untouched. If a domain change
seems to require altering one, re-read its rationale in
[ARCHITECTURE.md](ARCHITECTURE.md) first.
