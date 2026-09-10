/** The `hide` widget: take whatever is on screen down early. */
import type { OverlayContext } from "./index";

export function hideOverlay(ctx: OverlayContext): void {
  ctx.player.classList.remove("visible");
  ctx.player.removeAttribute("src");
}
