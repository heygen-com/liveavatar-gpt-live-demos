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

/**
 * A card code: rank char + suit char. Ranks 2-9, T, J, Q, K, A; suits
 * s(pades), h(earts), d(iamonds), c(lubs). "As", "Td", "3h".
 */
export type CardCode = string;

/**
 * Which part of the table changed, so the composition knows which cards to
 * animate. Everything else in the props renders statically — each message
 * carries the FULL table state and the client re-renders it idempotently.
 */
export type PokerReveal =
  | "new_hand"
  | "flop"
  | "turn"
  | "river"
  | "opponent"
  | "update";

/**
 * Props for the `poker_table` widget — the entire table, every message. The
 * state is SERVER truth (the orchestrator's simulator): the model never
 * supplies cards, pots, or stacks. `opponentHand` is null until showdown —
 * the composition shows card backs for it, and the hidden cards never even
 * cross the wire.
 */
export interface PokerTableProps {
  handNumber: number;
  playerHand: [CardCode, CardCode];
  /** 0, 3, 4, or 5 community cards. */
  board: CardCode[];
  /** Revealed only at showdown; null renders face-down backs. */
  opponentHand: [CardCode, CardCode] | null;
  potBb: number;
  playerStackBb: number;
  opponentStackBb: number;
  /** What the player owes to continue; 0 when they can check. */
  toCallBb: number;
  /** Session running total, big blinds won/lost across hands. */
  scoreBb: number;
  /** One short line: "Opponent calls. Flop." / "You win 12bb with two pair." */
  statusText: string;
  reveal: PokerReveal;
}

/**
 * One on-screen visual instruction. Every table change the orchestrator makes
 * lands in the browser as one of these, so the client renders visuals with a
 * single switch over `widget` (see web/src/overlays/).
 *
 * Staging is per-widget, decided by the client — not a model argument: the
 * poker table owns the stage and puts the avatar in the bottom-right corner
 * (PiP) while it is up.
 */
export type UiMessage =
  | { widget: "poker_table"; props: PokerTableProps }
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
