/**
 * The browser half of the UI channel: one switch over `widget`.
 *
 * Every visual the server sends arrives as `{ type: "ui", widget, props }` and
 * is routed here. One renderer module per widget.
 *
 * Staging is decided HERE, per widget — the model has no say in it. The poker
 * table owns the stage: it sets `data-pip`, shrinking the avatar to the
 * bottom-right corner while the table is up (see the #stage[data-pip] rules in
 * index.html). The table composition keeps that corner clear.
 */
import type { UiMessage } from "../../../shared/messages";
import { hideOverlay } from "./hide";
import { showPokerTable } from "./pokerTable";

export interface OverlayContext {
  /** #stage — the poker table stamps data-pip here to shrink the avatar. */
  stage: HTMLElement;
  /** The <hyperframes-player> element the compositions play in. */
  player: HTMLElement;
  onStatus: (msg: string) => void;
}

export interface Overlays {
  render: (msg: UiMessage) => void;
  hideAll: () => void;
}

export function createOverlays(ctx: OverlayContext): Overlays {
  const setPip = (on: boolean) => {
    if (on) ctx.stage.dataset.pip = "";
    else delete ctx.stage.dataset.pip;
  };

  const hideAll = () => {
    hideOverlay(ctx);
    setPip(false);
  };

  const render = (msg: UiMessage) => {
    switch (msg.widget) {
      case "poker_table":
        setPip(true);
        showPokerTable(ctx, msg.props);
        break;
      case "hide":
        hideAll();
        break;
      default:
        // A widget the server knows and this build doesn't. Loud, because the
        // whole point of the shared types is that this should be impossible.
        console.warn("[overlays] unknown widget", msg);
        break;
    }
  };

  // A composition clears itself when its own timeline ends. The poker table's
  // timeline is hours long on purpose — the table persists until replaced —
  // so in practice this fires for nothing, but the contract stays.
  ctx.player.addEventListener("ended", hideAll);
  ctx.player.addEventListener("error", (e) => {
    // The player also probes a src-less iframe; an error with no composition
    // in flight is not about this session.
    if (!ctx.player.getAttribute("src")) return;
    // The player dispatches a CustomEvent, but "error" is typed as ErrorEvent
    // by the DOM lib, so the detail has to be reached through unknown.
    const detail = (e as unknown as CustomEvent<{ message?: string }>).detail;
    ctx.onStatus(`overlay failed: ${detail?.message ?? "composition error"}`);
    hideAll();
  });

  return { render, hideAll };
}
