/**
 * The `poker_table` widget: plays public/overlays/poker-table.html — the whole
 * table, every time — while the avatar sits in the bottom-right corner
 * (overlays/index.ts sets the PiP for this widget).
 *
 * The full table state travels as one JSON-encoded query param. The
 * composition parses it defensively and renders with textContent — the status
 * line originates upstream, so it must never become markup. `reveal` tells the
 * composition which cards to animate; everything else renders statically, so
 * re-sending the full state on every change is idempotent.
 */
import type { PokerTableProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

/**
 * Table themes live in the composition (poker-table.html theme blocks); this
 * side only names them and sends the choice along as a query param. Staging
 * rule applies: the theme is client state — never a tool argument.
 */
export const POKER_THEMES = ["midnight", "velvet", "monte-carlo", "lounge"] as const;
export type PokerTheme = (typeof POKER_THEMES)[number];

const THEME_KEY = "poker-theme";

let theme: PokerTheme = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if ((POKER_THEMES as readonly string[]).includes(saved ?? "")) return saved as PokerTheme;
  } catch {
    // Storage blocked — session-local default is fine.
  }
  return "monte-carlo";
})();

// The last render, kept so a theme change can re-skin the live table in place.
let last: { ctx: OverlayContext; props: PokerTableProps } | null = null;

export function getPokerTheme(): PokerTheme {
  return theme;
}

export function setPokerTheme(next: PokerTheme): void {
  theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Best-effort persistence only.
  }
  // Re-render only a table that is actually up; reveal "update" so the
  // re-skin doesn't replay the last card animation.
  if (last && last.ctx.player.classList.contains("visible")) {
    showPokerTable(last.ctx, { ...last.props, reveal: "update" });
  }
}

// Cache-bust: two states can serialize identically apart from it (e.g. two
// checked-through streets), and an identical src would be a no-op.
let seq = 0;

export function showPokerTable(ctx: OverlayContext, props: PokerTableProps): void {
  last = { ctx, props };
  const qs = new URLSearchParams();
  qs.set("state", JSON.stringify(props));
  qs.set("theme", theme);
  qs.set("t", String(++seq));

  ctx.player.setAttribute("src", `/overlays/poker-table.html?${qs}`);
  ctx.player.classList.add("visible");
}
