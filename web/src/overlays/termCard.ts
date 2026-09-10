/**
 * The `term_card` widget: plays public/overlays/term-card.html in the
 * hyperframes player, with the card's content carried in the query string. The
 * composition reads location.search and renders with textContent — the values
 * come from a model and must never become markup.
 */
import type { TermCardProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

// Cache-bust: showing the same card twice must restart its timeline, and an
// identical src would be a no-op.
let seq = 0;

export function showTermCard(ctx: OverlayContext, props: TermCardProps): void {
  const qs = new URLSearchParams();
  qs.set("term", props.term);
  if (props.reading) qs.set("reading", props.reading);
  if (props.meaning) qs.set("meaning", props.meaning);
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/term-card.html?${qs}`);
  ctx.player.classList.add("visible");
}
