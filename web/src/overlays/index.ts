/**
 * The browser half of the UI channel: one switch over `widget`.
 *
 * Every visual the server sends arrives as `{ type: "ui", widget, props }` and
 * is routed here. One renderer module per widget — a new tool that reuses an
 * existing widget costs zero code in this directory.
 *
 * Staging is decided HERE, per widget — the model has no say in it. The
 * pricing sheet and the mode comparison set `data-pip` on the stage,
 * shrinking the avatar to the bottom-right corner while the panel is up (see
 * the #stage[data-pip] rules in index.html); the support card leaves the
 * avatar full-frame and keeps to the lower-left. Every widget also sets
 * `data-card`, which fades out the resting "Ask me anything" layer
 * (#home-player, public/overlays/home.html) until the screen is clear again.
 *
 * Not every widget is a composition: `support_contact` is host-page DOM,
 * because it has to be clickable and the player's iframe is sandboxed and
 * pointer-events: none (see supportContact.ts). `hideAll` therefore has to
 * clear both kinds.
 */
import type { UiMessage } from "../../../shared/messages";
import { hideOverlay } from "./hide";
import { showModeComparison } from "./modeComparison";
import { showPricingSheet } from "./pricingSheet";
import { hideSupportContact, showSupportContact } from "./supportContact";

export interface OverlayContext {
  /** #stage — full-stage widgets stamp data-pip here to shrink the avatar. */
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

  // data-card marks "a widget holds the screen": index.html fades the resting
  // home layer (#home-player) out while it is set, back in when it clears.
  const setCard = (on: boolean) => {
    if (on) ctx.stage.dataset.card = "";
    else delete ctx.stage.dataset.card;
  };

  const hideAll = () => {
    hideOverlay(ctx);
    hideSupportContact();
    setPip(false);
    setCard(false);
  };

  const render = (msg: UiMessage) => {
    switch (msg.widget) {
      case "pricing_sheet":
        setCard(true);
        setPip(true);
        showPricingSheet(ctx, msg.props);
        break;
      case "mode_comparison":
        setCard(true);
        setPip(true);
        showModeComparison(ctx, msg.props);
        break;
      case "support_contact":
        // Full-frame avatar, card in the lower-left. Also clears any
        // composition still playing: a hand-off is the end of that thread.
        setCard(true);
        setPip(false);
        hideOverlay(ctx);
        showSupportContact(ctx, msg.props);
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

  // A composition clears itself when its own timeline ends.
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
