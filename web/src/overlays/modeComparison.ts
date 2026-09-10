/**
 * The `mode_comparison` widget: plays public/overlays/mode-comparison.html —
 * FULL Mode against Avatar Only, two cards side by side — while the avatar
 * sits in the corner (overlays/index.ts sets the PiP for this widget).
 *
 * Each column travels as one JSON-encoded query param. The composition parses
 * them defensively and renders with textContent only; the columns are server
 * truth, but the headline comes from a model, so nothing here may become
 * markup.
 */
import type { ModeComparisonProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

// Cache-bust: showing the comparison twice must restart its timeline, and an
// identical src would be a no-op.
let seq = 0;

export function showModeComparison(ctx: OverlayContext, props: ModeComparisonProps): void {
  const qs = new URLSearchParams();
  qs.set("headline", props.headline);
  qs.set("full", JSON.stringify(props.full));
  qs.set("lite", JSON.stringify(props.lite));
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/mode-comparison.html?${qs}`);
  ctx.player.classList.add("visible");
}
