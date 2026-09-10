/**
 * The tool registry — how the model moves the poker game.
 *
 * Tools live ONLY on the delegated Responses model; the live speech model holds
 * none and reaches them by handing a turn to its backend (see
 * server/src/gptlive.ts). Each definition here carries the JSON schema the
 * model sees AND the TypeScript arg type the server dispatches on, co-located
 * so drift between them is visible in one screenful.
 *
 * Note what the tools do NOT carry: cards, pots, stacks, outcomes. The
 * simulator (server/src/poker.ts) is the only source of game state — the model
 * relays the player's decision and narrates the state the tool result hands
 * back. A model that could supply cards would misremember them.
 *
 * Keep every tool's set of REQUIRED argument names distinct. The GPT-Live
 * alpha's first tool-finalize event can arrive with the tool name missing, and
 * the arguments are then the only way to recover which tool fired — see
 * `inferToolName`.
 */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON-schema `properties` for the OpenAI function tool. */
  parameters: Record<string, unknown>;
  required: string[];
  /** Every declared parameter name, used by `inferToolName`. */
  keys: string[];
}

/** Args for `player_action`, as the dispatcher receives them (unvalidated). */
export interface PlayerActionArgs {
  action: string;
  amount_bb?: number;
}

/** Args for `deal_next_hand`. */
export interface DealNextHandArgs {
  ready: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: "player_action",
    description:
      "Execute the player's committed poker decision at the table — the ONLY way a bet, check, " +
      "call, or fold actually happens in the hand. Call it when the player commits to an action " +
      "('I raise to 3 big blinds', 'call', 'I'd fold here'), never while they are still thinking " +
      "out loud. The result returns exactly what happened at the table (opponent's response, new " +
      "cards, pot, whose action) — narrate THAT, never a guess.",
    parameters: {
      action: {
        type: "string",
        enum: ["bet", "raise", "check", "call", "fold"],
        description:
          "The player's decision. 'check' and 'call' both mean continue without raising — the " +
          "table picks whichever is legal. 'bet' and 'raise' both put chips in and need amount_bb.",
      },
      amount_bb: {
        type: "number",
        description:
          "For bet/raise: the size in big blinds the player names. Omit for check, call, or fold, " +
          "or when they don't name a size (the table picks a standard one).",
      },
    },
    required: ["action"],
    keys: ["action", "amount_bb"],
  },
  {
    name: "deal_next_hand",
    description:
      "Deal a fresh heads-up hand: shuffles, posts blinds, and puts the player's two hole cards " +
      "on screen. Call it when the player asks to play, deal, or move to the next hand — and only " +
      "between hands, never while one is in progress. The result returns the new hand's state: " +
      "the player's cards, the pot, and whose action it is.",
    parameters: {
      ready: {
        type: "boolean",
        description: "Always true — the player asked for a hand.",
      },
    },
    required: ["ready"],
    keys: ["ready"],
  },
];

/** The `tools` array handed to the Responses delegation config. */
export function toolSchemas(): Record<string, unknown>[] {
  return TOOLS.map((def) => ({
    type: "function",
    name: def.name,
    description: def.description,
    parameters: {
      type: "object",
      properties: def.parameters,
      required: def.required,
      additionalProperties: false,
    },
  }));
}

/**
 * Recover the tool from its arguments alone.
 *
 * The alpha fires `response.function_call_arguments.done` FIRST, with the name
 * (and call_id) undefined — and that event has already consumed the dedupe
 * slot, so dropping it would drop the call. Every tool declares a distinct set
 * of required keys, which makes the arguments identify it: score by key
 * overlap, penalize keys the tool doesn't declare, best score wins.
 */
export function inferToolName(args: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const def of TOOLS) {
    if (!def.required.every((k) => args[k] !== undefined)) continue;
    const keys = new Set(def.keys);
    const known = Object.keys(args).filter((k) => keys.has(k)).length;
    const unknown = Object.keys(args).filter((k) => !keys.has(k)).length;
    const score = known - unknown * 2;
    if (score > bestScore) {
      bestScore = score;
      best = def.name;
    }
  }
  return best;
}
