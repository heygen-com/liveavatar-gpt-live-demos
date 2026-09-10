# Repurposing the Demo

This starter ships as a Japanese tutor, and swapping the domain — support
agent, sales rep, museum docent — is the intended use. But "edit
`server/prompts/*.md` and restart" only re-skins the *persona*. Four areas of
deliberate, domain-specific behavior live in code, and **they are yours to
address when you repurpose** — they are design decisions of the tutor demo,
not bugs, and no generic mechanism replaces them.

(The fifth and biggest repurposing question — why your new visuals don't
appear in live sessions — has its own doc:
[MAKING_VISUALS_FIRE.md](MAKING_VISUALS_FIRE.md). Read it first.)

## 1. Tutor logic lives outside `prompts/*.md` — the excavation list

Editing only the markdown persona gets you a support avatar that *starts
teaching Japanese*. The tutor is wired into the mechanics layer in these
places; rewrite or remove each one for a new domain:

| Where | What |
| --- | --- |
| `server/src/prompts.ts` → `RESPONSES_INSTRUCTIONS` | Hardcodes "You are the translator behind a live Japanese tutor avatar" plus the show_term_card / show_learned_words behavioral rules. Keep the structural clauses (speech + tool in the same reply, speak plainly); replace the domain ones. |
| `server/src/prompts.ts` → `LESSON_WORDS`, `LESSON_DIRECTIVE` | The scripted opening curriculum, appended to the live model's instructions **unconditionally** at startup (`gptlive.ts`). Remove or replace with your own opening script. |
| `server/src/prompts.ts` → `REVIEW_BREAK_PROMPT`, `SILENCE_CHECKIN` | Learner-flavored ("you've got this", "say the word again"). The silence check-in mechanism is worth keeping — reword it. |
| `server/src/session.ts` → lesson push in `onTurn` | Watches the tutor's transcript for `LESSON_WORDS` and pushes cards server-side. Remove with the lesson — but note it is also the reference implementation of the most reliable visual-trigger pattern (Pattern 1 in MAKING_VISUALS_FIRE.md). |
| `server/src/session.ts` → `learnedWords` store, `RECAP_EVERY_WORDS` auto-recap, `reviewFallback` | The recap machinery: every term card is recorded, and a review break fires every few new words. Remove with `show_learned_words`, or repurpose the store pattern (see §4). |

`pnpm typecheck` catches the removals that break types (deleting a widget
from the `UiMessage` union flags its render sites); it cannot catch leftover
prompt text, so grep `prompts.ts` for tutor vocabulary when you're done.

## 2. Tool naming: the required-key sets already taken

Every tool's `required` array must be distinct — it is how a name-less tool
call is recovered (`inferToolName`, see the invariant in
[ADDING_FRONTEND_COMPONENTS.md](ADDING_FRONTEND_COMPONENTS.md#2-sharedtoolsts--register-the-tool-the-model-calls)).
Nothing enforces this; a collision is silent and probabilistic — the
name-less finalize event routes to the wrong tool, and the wrong widget (or
none) renders.

Currently taken: `["term"]`, `["title"]`, `["reason"]`. The natural names for
a new domain collide immediately — a `show_pricing { title }` is
indistinguishable from `show_learned_words`, a `show_contact_card { reason }`
from `hide_card`. Before writing a schema, list every tool's `required` set
and pick something disjoint (`["plan"]`, `["contact_channel"]`, …). If you
delete the tutor tools, their key sets free up.

## 3. Compositions are ephemeral broadcast graphics — not interactive UI

The composition contract assumes a lower-third that plays and leaves: fixed
`data-duration`, timeline pinned to it, player `ended` → overlay cleared. The
page runs in a sandboxed iframe with no click plumbing.

A persistent or interactive element — a contact card that stays up until
dismissed, a clickable `mailto:`, a button — fights all of that. Options,
honest about their cost:

- **Long duration + `hide_card`.** A large `data-duration` keeps the card up;
  the model (or a server push) takes it down. Still not clickable; the exit
  animation beat is lost.
- **Render it in the host page, not the player.** For genuinely interactive
  UI, add a plain DOM overlay in `web/` (the renderer module receives the
  stage element via `OverlayContext`) and skip the composition entirely —
  the widget/renderer pipeline doesn't require the player. You own its
  show/hide lifecycle; the player's `ended`-clears-it convention no longer
  applies.
- Keep compositions for what they're good at — animated, timed, on-brand
  moments — and put buttons in the page.

## 4. Server-owned data: the plumbing is bespoke, extend it deliberately

The rule (see the recap invariant): **the model supplies selectors, never
data.** Prices, contact channels, account facts — if the model supplies the
strings, the avatar will eventually show a hallucinated price to a customer.
The dispatcher's clamps limit length, not truth.

The demo's one server-owned store is threaded literally:
`dispatchToolCall(name, args, learnedWords)` — the third parameter *is* the
word list. Adding your own store (a pricing table, a support directory)
means widening that seam: either grow the signature or replace it with a
session-state object the dispatcher reads from. Keep the shape of the
existing pattern: the store lives on the session, the tool schema carries
only what the model may legitimately choose (a plan name, a heading), and
the dispatch case renders from the store.

## Not on this list

Barge-in, silence reconstruction, the greeting gate, teardown, dedupe — the
invariants in [AGENTS.md](../AGENTS.md) are domain-independent and survive
any repurposing untouched. If a domain change seems to require altering one,
re-read its rationale in [ARCHITECTURE.md](ARCHITECTURE.md) first.
