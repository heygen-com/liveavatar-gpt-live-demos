# Adding Front End Components

The complete walkthrough for putting a new visual on the learner's screen —
from authoring the Hyperframes composition to wiring every hook between the
model's tool call and the pixels. Design rationale lives in
[ARCHITECTURE.md](ARCHITECTURE.md); this is the how-to.

## The pipeline you are plugging into

Every visual in this demo travels one path:

```
Responses model            fires a tool call (registry: shared/tools.ts)
  └► server/src/gptlive.ts   finalizes + dedupes the call
      └► server/src/session.ts  hands it to the dispatcher
          └► server/src/tools.ts  dispatchToolCall: args → { widget, props }, clamped
              └► /ws/{session_id}   { type: "ui", widget, props }   (shared/messages.ts)
                  └► web/src/overlays/index.ts  one switch over `widget`, staging decided here
                      └► web/src/overlays/<widget>.ts  builds a URL, points the player at it
                          └► <hyperframes-player src="/overlays/<name>.html?props...">
                              └► web/public/overlays/<name>.html  the composition — plays, ends, clears
```

Three sizes of change, smallest first:

| You want | Touch |
| --- | --- |
| A new tool that reuses an existing widget | `shared/tools.ts` + `server/src/tools.ts` — done |
| A new widget with a new on-screen look | Everything below |
| A widget with no composition (like `hide`) | Everything below except Part 1 |

The rest of this doc is the full path: Part 1 builds the composition, Part 2
wires the hooks.

---

## Part 1 — Creating the Hyperframes composition

A composition is one self-contained HTML page under `web/public/overlays/`,
played by `<hyperframes-player>` in a sandboxed iframe layered over the
avatar's live video. Nothing is composited into the video stream — the page is
transparent and the WebRTC video shows through underneath.

Start by copying `web/public/overlays/term-card.html`. It is the reference
implementation of every rule below.

### The contract

**1. A root element with the composition data attributes.**

```html
<div id="root" data-composition-id="my-widget" data-start="0" data-duration="8"
     data-width="1920" data-height="1080">
```

The player reads these to know what it is playing and for how long. The canvas
is a fixed 1920×1080 — size `html, body` and `#root` to exactly that and set
`overflow: hidden`.

**2. One paused GSAP timeline, registered synchronously.**

```js
const tl = gsap.timeline({ paused: true });
// ...tweens...
window.__timelines = window.__timelines || {};
window.__timelines["my-widget"] = tl;
```

The player drives the timeline; the page never plays itself. Registration must
be synchronous on first execution — the player probes the iframe for
`window.__timelines` a few times and then falls back to a degraded path, so
nothing async (no module imports, no deferred scripts, no awaits) may run
before that assignment.

**3. GSAP is vendored, not fetched.**

```html
<script src="./vendor/gsap.min.js"></script>
```

Same reason: a slow CDN fetch delays timeline registration past the player's
probe window. The vendored file already exists at
`web/public/overlays/vendor/gsap.min.js` — just reference it.

**4. `color-scheme: light` on `html, body`, matching the host page.**

```css
html, body { color-scheme: light; background: transparent; }
```

This is the gotcha that whites out the whole avatar: Chrome paints an opaque
base behind any iframe whose used color scheme differs from its embedder's.
The host page (`web/index.html`) is dark; a composition left on the default
scheme renders as an opaque white sheet no matter how transparent its
background claims to be.

**5. Props arrive in the query string, never postMessage.**

The sandboxed iframe makes parent/child messaging a handshake race; reading
`location.search` sidesteps it entirely. The client-side renderer (Part 2,
step 4) builds the URL — so new props are just a new `src`.

```js
const params = new URLSearchParams(location.search);
document.getElementById("term").textContent = (params.get("term") || "").trim();
```

For structured props (arrays, objects), JSON-encode them into one param on the
client and parse defensively in the composition — see `learned-words.html` /
`learnedWords.ts` for the pattern.

**6. `textContent` only. Never `innerHTML`.**

Every value originates from a model and is untrusted markup. The server clamps
lengths (Part 2, step 3); the composition's job is to never let a value become
HTML. Collapse empty optional fields (`.empty { display: none }`) so a sparse
card isn't padded by blank rows.

**7. Pin the timeline length to `data-duration`, and animate the exit.**

```js
const DURATION = 8; // must match data-duration
tl.to("#card", { opacity: 0, duration: 0.5 }, DURATION - 0.5);
```

When the timeline ends, the player fires `ended` and `overlays/index.ts`
clears the overlay — compositions take themselves down. The `hide_card` tool
exists only to take one down *early*.

**8. Mind the stage layout.**

The bottom-right quadrant is where the avatar sits when a widget runs in PiP
staging (see Part 2, step 5). A lower-third widget (like the term card) keeps
to the lower-left; a full-stage widget (like the recap panel) can use the
frame but should leave the bottom-right corner clear.

### Previewing a composition

Opening the HTML file directly in a tab shows only its first frame — the
timeline is paused and nothing drives it. The way to see it play is through
the player via the console hook (no session, no billing):

```js
window.__ui({ widget: "my_widget", props: { ... } });
```

…which requires the wiring in Part 2. Do Part 2 first if you want to iterate
visually; the composition and its renderer are the two halves of one URL.

---

## Part 2 — Wiring the hooks

Worked example throughout: a `show_example_sentence` tool rendering an
`example_sentence` widget. Steps 1–2 are the shared contract, 3 is the server,
4–5 are the client, 6 is the prompt.

### 1. `shared/messages.ts` — declare the widget on the wire protocol

Add a props interface and a member to the `UiMessage` union:

```ts
export interface ExampleSentenceProps {
  sentence: string;
  translation?: string;
}

export type UiMessage =
  | { widget: "term_card"; props: TermCardProps }
  | { widget: "learned_words"; props: LearnedWordsProps }
  | { widget: "example_sentence"; props: ExampleSentenceProps }
  | { widget: "hide"; props: Record<string, never> };
```

This file IS the contract: the server imports it to type what it emits, the
client to type its render switch. A widget the server can send that the client
cannot render is a compile error, not a runtime mystery — after this step,
`pnpm typecheck` fails until steps 3–5 exist, which is the point.

### 2. `shared/tools.ts` — register the tool the model calls

Add an args interface and a `ToolDef` to the `TOOLS` array:

```ts
export interface ShowExampleSentenceArgs {
  sentence: string;
  translation?: string;
}

{
  name: "show_example_sentence",
  description: "Put an example sentence on the learner's screen…",
  parameters: {
    sentence: { type: "string", description: "The sentence in the target language." },
    translation: { type: "string", description: "English translation. Optional." },
  },
  required: ["sentence"],
  keys: ["sentence", "translation"],
}
```

**The invariant: keep the `required` set distinct from every other tool's.**
The dispatcher falls back to `inferToolName` when a function-call item
arrives without a `name` — it recovers the tool by matching required keys.
Two tools with the same required set are indistinguishable there, and one of
them silently becomes the other. (`["term"]`, `["title"]`,
`["reason"]` are taken.)

`toolSchemas()` picks the new definition up automatically — nothing else to
register.

### 3. `server/src/tools.ts` — map the call to a widget message

Add a case to `dispatchToolCall`. Clamp **every** string — the values come
from a model and are untrusted; this is the only choke point before the wire:

```ts
case "show_example_sentence": {
  const sentence = text(args.sentence, 200);
  if (!sentence) return null; // invalid call → dropped, not rendered
  const props: ExampleSentenceProps = { sentence };
  const translation = text(args.translation, 200);
  if (translation) props.translation = translation;
  return { widget: "example_sentence", props };
}
```

Returning `null` drops the call — dropping beats rendering a broken widget.

If the widget renders **server state** rather than model-supplied data, thread
it in the way `learnedWords` is: `session.ts` owns the store, passes it as an
argument to `dispatchToolCall`, and the tool schema only carries what the
model may legitimately supply (the recap tool takes a `title`, never the word
list — the model would misremember it).

### 4. `web/src/overlays/exampleSentence.ts` — the renderer module

One module per widget: encode the props into the composition URL and point the
player at it.

```ts
import type { ExampleSentenceProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

// Cache-bust: showing the same widget twice must restart its timeline,
// and an identical src would be a no-op.
let seq = 0;

export function showExampleSentence(ctx: OverlayContext, props: ExampleSentenceProps): void {
  const qs = new URLSearchParams();
  qs.set("sentence", props.sentence);
  if (props.translation) qs.set("translation", props.translation);
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/example-sentence.html?${qs}`);
  ctx.player.classList.add("visible");
}
```

The `t` param is load-bearing: setting an identical `src` is a no-op, so a
repeated widget would never replay without it.

### 5. `web/src/overlays/index.ts` — route it, and decide its staging

Add a case to the `render` switch:

```ts
case "example_sentence":
  setPip(false);                        // staging decision lives HERE
  showExampleSentence(ctx, msg.props);
  break;
```

**Staging is per-widget and client-decided — never a tool argument.**
`setPip(true)` stamps `data-pip` on the stage and shrinks the avatar to the
bottom-right corner (what the recap panel does); `setPip(false)` keeps the
avatar full-frame with the widget overlaid (what the term card does). Keeping
layout out of the tool schema keeps the model from arguing with the product
about staging.

### 6. `server/src/prompts.ts` — tell the model when to use it

Being in the registry makes a tool *callable*, not *called*. If the model
should reach for it unprompted, say so in `RESPONSES_INSTRUCTIONS` — when to
fire it, and anything it must not do (the existing tools' entries are the
template). Even then, expect the tool to fire only when the user explicitly
asks — the live model delegates on capability gaps, not prose. The trigger
patterns that reliably put visuals on screen are their own doc:
[MAKING_VISUALS_FIRE.md](MAKING_VISUALS_FIRE.md).

---

## Testing

**Without a session** (no billing, instant iteration) — `pnpm dev` (or
`pnpm --dir web dev` if you don't have the env keys — the `__ui` path needs
no server), open the app, and drive the widget from the browser console:

```js
window.__ui({ widget: "example_sentence", props: { sentence: "お茶をください", translation: "Tea, please." } });
window.__ui({ widget: "hide", props: {} });
```

`__ui` is `overlays.render` exposed on `window` (`web/src/main.ts`) — it
exercises everything from the wire message down, including staging and the
composition itself.

**Types:** `pnpm typecheck` — it compiles `shared/` from both sides, so a
missed step 1/3/4/5 surfaces here.

**Full loop:** start a real session and ask the tutor for the behavior. Two
things to know when watching the server logs:

- Every tool call must be **answered**: `onToolCall` (`server/src/session.ts`)
  returns a result object and the bridge sends it back as a
  `function_call_output` followed by `response.create` — an unanswered call
  stays pending and blocks every later delegation, which is why even invalid calls get an error result. New
  widgets get `{ shown: true }` for free; if the widget renders server state,
  put that state in the result (the recap returns the exact words on the
  panel) so the model's continued speech matches the screen.
- The spoken line that accompanies the visual is the Responses model's reply
  text, auto-injected into the live session — if the avatar shows the widget
  but says nothing, the prompt (step 6) isn't insisting on speech + tool in
  the same reply.

## Checklist

- [ ] Composition under `web/public/overlays/`: `data-composition-id` root, synchronous `window.__timelines` registration, vendored GSAP, `color-scheme: light`, `textContent` only, exit animation, length pinned to `data-duration`
- [ ] `shared/messages.ts`: props interface + `UiMessage` union member
- [ ] `shared/tools.ts`: `ToolDef` with a **distinct required-key set** + args interface
- [ ] `server/src/tools.ts`: `dispatchToolCall` case, every string clamped, `null` on invalid
- [ ] `web/src/overlays/<widget>.ts`: renderer with cache-bust param
- [ ] `web/src/overlays/index.ts`: switch case + staging (`setPip`)
- [ ] `server/src/prompts.ts`: `RESPONSES_INSTRUCTIONS` mention (if the model should use it unprompted)
- [ ] `pnpm typecheck` passes; `window.__ui(...)` plays it
