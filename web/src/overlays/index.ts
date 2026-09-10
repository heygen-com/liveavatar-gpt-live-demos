/**
 * The browser half of the UI channel: one switch over `widget`.
 *
 * Every visual the server sends arrives as `{ type: "ui", widget, props }` and
 * is routed here. One renderer module per widget — a new tool that reuses an
 * existing widget costs zero code in this directory.
 *
 * Staging is decided HERE, per widget — the model has no say in it. A term
 * card overlays the full-frame avatar; the learned-words recap sets `data-pip`
 * on the stage, shrinking the avatar to the bottom-right corner while the
 * panel is up (see the #stage[data-pip] rules in index.html).
 */
import type { UiMessage } from "../../../shared/messages";
import { hideOverlay } from "./hide";
import { showLearnedWords } from "./learnedWords";
import { showTermCard } from "./termCard";

export interface OverlayContext {
  /** #stage — the recap widget stamps data-pip here to shrink the avatar. */
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
      case "term_card":
        setPip(false);
        showTermCard(ctx, msg.props);
        break;
      case "learned_words":
        setPip(true);
        showLearnedWords(ctx, msg.props);
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
