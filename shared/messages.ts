/**
 * The wire protocol between the web client and the orchestrator.
 *
 * This file IS the contract. The server imports it to type what it emits, the
 * client imports it to type its message switch — so a widget the server can
 * send that the client cannot render is a compile error, not a runtime mystery.
 *
 * Deliberately absent: avatar audio and video. Those reach the browser over
 * LiveKit (the server threads GPT-Live's audio into the avatar directly), so
 * this socket only carries what LiveKit cannot — mic audio up, transcripts and
 * tool-driven visuals down.
 */

/** One row on the pricing sheet: a plan and what it costs. */
export interface PricingRow {
  /** Plan or line-item name: "FULL Mode". */
  plan: string;
  /** The price line: "2 credits / minute". */
  price: string;
  /** One-line qualifier: "LiveAvatar runs ASR, LLM, TTS, and WebRTC." */
  detail?: string;
}

/**
 * Props for the `pricing_sheet` widget — the pricing panel. This one owns the
 * stage: the client shrinks the avatar to the bottom-right corner while it is
 * up. The rows come from the SERVER's pricing table (server/src/tools.ts),
 * never from the model — the model only asks for the sheet and supplies a
 * heading, so it cannot misquote a price.
 */
export interface PricingSheetProps {
  title: string;
  rows: PricingRow[];
  footnote?: string;
}

/**
 * One column of the mode comparison: Full mode or Avatar Only, and the
 * pieces of the pipeline it does or does not bring.
 */
export interface ModeColumn {
  /** "FULL Mode" / "Avatar Only (LITE)". */
  name: string;
  /** One-line positioning under the name. */
  tagline: string;
  /** The headline cost line: "2 credits / minute". */
  price: string;
  /**
   * Pipeline pieces, in pipeline order. `included: false` renders as "you
   * bring this" — that contrast IS the visual, so both columns carry the
   * same labels in the same order and only the values differ.
   */
  parts: { label: string; value: string; included: boolean }[];
  /** Who the mode is for: "Quick end-to-end integration". */
  bestFor: string;
}

/**
 * Props for the `mode_comparison` widget — two cards side by side, showing
 * what Full mode includes against what Avatar Only leaves to the customer.
 * Full-stage: the client shrinks the avatar to the corner while it is up.
 * Both columns are SERVER truth (server/src/tools.ts); the model supplies
 * only the headline.
 */
export interface ModeComparisonProps {
  headline: string;
  full: ModeColumn;
  lite: ModeColumn;
}

/**
 * Props for the `support_contact` widget — the hand-off card, shown when an
 * ask needs a human (refunds, avatar approvals, account trouble) or is one
 * the agent genuinely cannot answer.
 *
 * Unlike every other widget this one is NOT a Hyperframes composition: it is
 * real DOM in the host page (web/src/overlays/supportContact.ts). It has to
 * be clickable, and a composition cannot be — the player's iframe is
 * sandboxed `allow-scripts allow-same-origin` (no popups, no top-level
 * navigation, so a `mailto:` is inert) and `#overlay-player` is
 * `pointer-events: none`. It also has no timeline to end: the user dismisses
 * it, or the next widget replaces it.
 *
 * `subject` and `body` pre-fill the mailto — the model supplies a summary of
 * what the user actually asked, and the server builds the rest.
 */
export interface SupportContactProps {
  title: string;
  /** Where it goes. Server-owned — never a model argument. */
  email: string;
  /** One or two plain lines on why this one needs a human. */
  note: string;
  /** Pre-filled mailto subject. */
  subject: string;
  /** Pre-filled mailto body. */
  body: string;
}

/**
 * One on-screen visual instruction. Every tool call the model makes lands in
 * the browser as one of these, so the client renders visuals with a single
 * switch over `widget` (see web/src/overlays/). A new tool that reuses an
 * existing widget costs zero client code.
 *
 * Staging is per-widget, decided by the client — not a model argument: the
 * pricing sheet and the mode comparison put the avatar in a corner while the
 * panel holds the stage; the support card sits over the full-frame avatar.
 */
export type UiMessage =
  | { widget: "pricing_sheet"; props: PricingSheetProps }
  | { widget: "mode_comparison"; props: ModeComparisonProps }
  | { widget: "support_contact"; props: SupportContactProps }
  | { widget: "hide"; props: Record<string, never> };

export type Widget = UiMessage["widget"];

/**
 * One conversational turn, projected from GPT-Live's transcript fragments.
 * Streaming updates re-send the same `id` with longer `text`; the client
 * rewrites that line in place and only breaks to a new line on a new id.
 */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}

/** Server → browser. */
export type ServerMessage =
  | { type: "ready" }
  | ({ type: "turn" } & Turn)
  | ({ type: "ui" } & UiMessage)
  /** The avatar was cut off mid-sentence; what it was saying is never coming. */
  | { type: "interrupted" }
  | { type: "error"; message: string };

/** Browser → server. */
export type ClientMessage =
  /** Base64 PCM16 mono @ 24kHz, produced by the AudioWorklet in micCapture.ts. */
  | { type: "mic_audio"; audio: string }
  | { type: "stop" };
