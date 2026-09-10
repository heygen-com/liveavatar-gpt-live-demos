/**
 * The tool-argument layer: model args in, engine-ready values out.
 *
 * Values come from a model, so they are untrusted: normalize and clamp here.
 * The game itself never renders model text — the poker_table widget is built
 * from the SIMULATOR's snapshot (server/src/poker.ts), so a hallucinated card
 * or pot cannot reach the screen. The only model-supplied inputs that touch
 * the game are the action verb and an optional bet size, both validated below.
 */

import type { PokerTableProps, UiMessage } from "../../shared/messages";
import type { PlayerAction, Reveal, Snapshot } from "./poker";

/** Max bet the dispatcher will pass through, in bb — the engine clamps to the
 * stack anyway; this just keeps absurd numbers out of the narration. */
const MAX_BET_BB = 1000;

export interface ParsedAction {
  action: PlayerAction;
  amountBb?: number;
}

/**
 * Normalize the model's action verb into the engine's three buckets:
 * bet/raise → bet, check/call (either word) → check_call, fold → fold.
 * Returns null for anything else — dropping beats guessing.
 */
export function parsePlayerAction(
  args: Record<string, unknown>,
): ParsedAction | null {
  const verb =
    typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  let action: PlayerAction;
  if (verb === "bet" || verb === "raise") action = "bet";
  else if (verb === "check" || verb === "call" || verb === "check_call" || verb === "check/call")
    action = "check_call";
  else if (verb === "fold") action = "fold";
  else return null;

  const parsed: ParsedAction = { action };
  if (action === "bet") {
    const n = Number(args.amount_bb);
    if (Number.isFinite(n) && n > 0) parsed.amountBb = Math.min(n, MAX_BET_BB);
  }
  return parsed;
}

/** Project an engine snapshot into the wire message the browser renders. */
export function tableUi(snapshot: Snapshot, reveal: Reveal): UiMessage {
  const props: PokerTableProps = {
    handNumber: snapshot.handNumber,
    playerHand: snapshot.playerHand,
    board: snapshot.board,
    opponentHand: snapshot.opponentHand,
    potBb: snapshot.potBb,
    playerStackBb: snapshot.playerStackBb,
    opponentStackBb: snapshot.opponentStackBb,
    toCallBb: snapshot.toCallBb,
    scoreBb: snapshot.scoreBb,
    statusText: snapshot.statusText,
    reveal,
  };
  return { widget: "poker_table", props };
}
