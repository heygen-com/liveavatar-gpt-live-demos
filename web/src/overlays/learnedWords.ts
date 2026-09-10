/**
 * The `learned_words` widget: plays public/overlays/learned-words.html — the
 * recap panel — while the avatar sits in the corner (overlays/index.ts sets
 * the PiP for this widget).
 *
 * The word list travels as one JSON-encoded query param. The composition
 * parses it defensively and renders with textContent — the values originate
 * from a model, so they must never become markup.
 */
import type { LearnedWordsProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

// Cache-bust: showing the recap twice must restart its timeline, and an
// identical src would be a no-op.
let seq = 0;

export function showLearnedWords(ctx: OverlayContext, props: LearnedWordsProps): void {
  const qs = new URLSearchParams();
  qs.set("title", props.title);
  qs.set("words", JSON.stringify(props.words));
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/learned-words.html?${qs}`);
  ctx.player.classList.add("visible");
}
