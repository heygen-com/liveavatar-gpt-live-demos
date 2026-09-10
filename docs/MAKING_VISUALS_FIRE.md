# Making Visuals Actually Fire

[ADDING_FRONTEND_COMPONENTS.md](ADDING_FRONTEND_COMPONENTS.md) gets a widget
*callable*. This doc is about the harder half: getting it **called** in a live
session. They are different problems, and the gap between them is the single
biggest trap in this codebase.

## The trap

You follow the recipe. `pnpm typecheck` is green. `window.__ui({...})` plays
your card beautifully. Then you start a real session, ask the avatar the
question your tool exists for — and it just *answers out loud*. No card. No
error. No log line. Nothing to debug, because nothing happened.

## Why: delegation fires on capability gaps, not instructions

Two models cooperate (see [ARCHITECTURE.md](ARCHITECTURE.md#tool-calls--overlays)):
the **live model** speaks and holds no tools; the **Responses model** holds
the tools and only runs when the live model *hands a turn to it* (a
"delegation"). Your widget cannot appear unless that handoff happens first.

GPT-Live's delegation is trained to fire on **capability gaps** — current
information, deep reasoning, things the live model knows it cannot do itself.
It is not an obedience mechanism. Prose in the instructions asking the model
to delegate things it can already answer does approximately nothing:

> Measured, twice: prose asking the live model to delegate its own teaching
> moments never fired once (`backend_model_usage: []`), while an explicit
> learner request ("teach me the word for respect") delegated instantly.
> — `server/src/prompts.ts`

Teaching "hello" is within the live model's own ability, so it answers
directly no matter what the prompt says. So is explaining your pricing, your
support hours, or anything else already in its instructions. **If the live
model can answer it, it will — out loud, with no delegation, and your tool
never runs.**

This is why the demo's own lesson cards don't use the tool path at all (next
section).

## The three patterns that work

In order of reliability. Real deployments usually combine them.

### Pattern 1 — server-side push keyed on the transcript (most reliable)

Skip the model's cooperation entirely: the server already sees every
transcript fragment in `onTurn` (`server/src/session.ts`). Watch the text,
and when your trigger content appears, build the `UiMessage` yourself and
emit it — same dispatcher, same wire message, no tool call involved.

This is exactly how the scripted lesson works: the first time the tutor is
*heard saying* a lesson word, the server pushes that word's card
(`session.ts`, the `LESSON_WORDS` loop in `onTurn`). Details worth copying:

- **Checked on every streaming update**, not on turn end — the card lands
  mid-sentence, alongside the word, not seconds after.
- **Passive.** It never writes into the conversation, so it cannot disturb
  the model's pacing. The model doesn't know or care that a visual appeared.
- **Deduped** with a per-session set (`taughtLessonTerms`), so a repeated
  word doesn't re-fire the card.
- **The data is server-owned** (`LESSON_WORDS`) — the visual renders truth
  the server holds, not text the model produced.

For a domain like support/pricing: match the *assistant's* turns (the avatar
is talking about pricing right now → show the pricing card) rather than the
user's — the assistant transcript is cleaner, and it synchronizes the visual
with the speech instead of with the question. Matching user turns works too,
just expect paraphrase and transcription noise.

One caveat: transcripts arrive seconds ahead of the avatar's *audible* voice.
For a card that must land on a heard word this is usually fine (the lesson
accepts it); for tight sync see "audible-time scheduling" under production
hardening in ARCHITECTURE.md.

### Pattern 2 — prod + fallback (the review-break pattern)

When you want the model's **spoken reply synchronized with the visual** (it
should talk through what's on screen), you need the delegation — but you must
not depend on it. The review break (`session.ts`) is the template:

1. Append an instruction asking the model to hand the turn to its backend:
   `this.bridge.append("instructions", REVIEW_BREAK_PROMPT)`.
2. Arm a timeout (`REVIEW_DELEGATION_TIMEOUT_MS`). If it fires, call
   `dispatchToolCall(...)` directly and emit the result — the visual appears
   even though the model never delegated.
3. If the delegation *does* arrive, `onToolCall` clears the fallback so the
   panel isn't pushed twice.

The comment in the code says it best: *"Insurance, not the plan: the live
model has a documented history of not delegating when asked. The visual must
not depend on obedience."* You lose speech/screen sync on the fallback path —
the model talks about whatever it was talking about — which is why the prompt
still asks first.

### Pattern 3 — explicit-request delegation triggers (works, narrowly)

Delegation *does* fire reliably for one shape: **the user explicitly asks for
something**, phrased as a concrete trigger in the live model's startup
instructions. "Whenever the learner asks for a word, phrase, or translation,
delegate that turn to your backend" fires instantly on "how do I say
'respect'?".

To add a domain trigger, extend `LIVE_DIRECTIVE` (`server/src/prompts.ts`)
with the *user-utterance shape*, not the model's intention:

- Works: "Whenever the user asks about pricing, plans, or what it costs,
  delegate that turn to your backend and let it answer."
- Doesn't: "When discussing pricing, show the pricing card." (The live model
  holds no tools; it can't. And it won't delegate for something it can say.)

Two rules from hard-won measurement (both documented in `prompts.ts`):

- **Steering goes in the startup instructions, never mid-session appends.**
  An append lands as new context the model acts on IMMEDIATELY, cutting off
  whatever loop it was running.
- Once the delegation happens, the tool call is the *Responses* model's job —
  `RESPONSES_INSTRUCTIONS` must insist on it ("MANDATORY: … call
  show_term_card in THIS reply") and on speech in the same reply, or you get
  a card with a silent avatar.

Expect Pattern 3 to cover direct questions and nothing else. The model taking
initiative ("I should show a card here") is not a thing prose can buy —
that's what Patterns 1 and 2 are for.

## Debugging ladder

Work upward from the screen; each step isolates one layer.

1. **`window.__ui({ widget, props })` in the console.** Doesn't render → the
   problem is client wiring (renderer, switch case, composition — see the
   other doc's checklist). Renders → everything below the wire is fine; the
   problem is upstream.
2. **Live session, server logs, look for `tool → <widget> …`**
   (`session.ts onToolCall`). Present → the tool fired and dispatched; if no
   card showed, check the browser console for the overlays warning.
3. **`tool call ignored: …` instead** → the tool fired but the dispatcher
   dropped it: name inference failed (required-key collision — see
   [REPURPOSING.md](REPURPOSING.md)), a clamp emptied a required string, or
   the widget's server state was empty.
4. **Neither line ever appears** → no delegation happened. Confirm with
   `gptlive delegation created` in the logs (v3 reports no backend usage on
   the session; each delegation's own `response.event` stream is the only
   trace) — none all session means the live model never delegated. No dispatcher or schema change will fix this;
   re-read the patterns above and move the trigger server-side.
5. **It fired once, then every later visual dies** → a tool call went
   unanswered. Every call must get a `function_call_output` **and** a
   `response.create` or it stays pending and blocks all later delegations (the frozen-delegation bug —
   `gptlive.ts`). `onToolCall` answers even invalid calls for this reason;
   keep it that way.

## Iterating without GPT-Live access

`pnpm dev` at the root preflights ALL required env — including the
limited-access `GPT_LIVE_MODEL` — before starting anything. For pure visual
work none of that is needed: run the web client alone,

```bash
pnpm --dir web dev
```

and drive widgets with `window.__ui(...)`. Session start will fail (no
server), but the overlay pipeline from wire message to composition is fully
exercisable, billing-free.
