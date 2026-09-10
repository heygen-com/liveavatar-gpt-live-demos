/**
 * The `pricing_sheet` widget: plays public/overlays/pricing-sheet.html — the
 * pricing panel — while the avatar sits in the corner (overlays/index.ts sets
 * the PiP for this widget).
 *
 * The row list travels as one JSON-encoded query param. The composition
 * parses it defensively and renders with textContent — the title originates
 * from a model, so it must never become markup (the rows are server truth,
 * but the same rule costs nothing).
 */
import type { PricingSheetProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

// Cache-bust: showing the sheet twice must restart its timeline, and an
// identical src would be a no-op.
let seq = 0;

export function showPricingSheet(ctx: OverlayContext, props: PricingSheetProps): void {
  const qs = new URLSearchParams();
  qs.set("title", props.title);
  qs.set("rows", JSON.stringify(props.rows));
  if (props.footnote) qs.set("footnote", props.footnote);
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/pricing-sheet.html?${qs}`);
  ctx.player.classList.add("visible");
}
