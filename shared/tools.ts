/**
 * The tool registry — what the model can put on screen.
 *
 * Tools live ONLY on the delegated Responses model; the live speech model holds
 * none and reaches them by handing a turn to its backend (see
 * server/src/gptlive.ts). Each definition here carries the JSON schema the
 * model sees AND the TypeScript arg type the server dispatches on, co-located
 * so drift between them is visible in one screenful.
 *
 * To add a tool:
 *   1. Add its definition here (schema + arg type).
 *   2. Map it to a widget in server/src/tools.ts.
 *   3. If it needs a NEW widget: add the widget to shared/messages.ts and a
 *      renderer in web/src/overlays/. Reusing an existing widget skips step 3.
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

/** Args for `show_pricing_sheet`. The prices themselves are server state. */
export interface ShowPricingSheetArgs {
  title: string;
}

/** Args for `show_mode_comparison`. Both columns are server state. */
export interface ShowModeComparisonArgs {
  headline: string;
}

/**
 * Args for `show_support_contact`. The address is server state; the model
 * supplies what the person actually asked so the email arrives pre-filled.
 */
export interface ShowSupportContactArgs {
  summary: string;
  topic?: string;
}

/** Args for `hide_card`. */
export interface HideCardArgs {
  reason: string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "show_pricing_sheet",
    description:
      "Show the LiveAvatar pricing sheet: per-minute credit rates for FULL and LITE mode and the " +
      "enterprise credit pricing. The panel takes the whole screen and your video shrinks to the " +
      "corner while it is up. The backend already holds the prices — you only supply the heading, " +
      "and the tool result returns the exact rows placed on the sheet. Call this whenever the " +
      "user asks about pricing, plans, credits, or what LiveAvatar costs.",
    parameters: {
      title: {
        type: "string",
        description: "Heading for the sheet, e.g. 'LiveAvatar pricing' or 'What a session costs'.",
      },
    },
    required: ["title"],
    keys: ["title"],
  },
  {
    name: "show_mode_comparison",
    description:
      "Show the Full mode vs Avatar Only comparison: two cards side by side listing what each " +
      "mode brings — LLM, text-to-speech, speech recognition, avatar rendering — with Full mode " +
      "showing everything included and Avatar Only showing which pieces the customer wires up " +
      "themselves. The panel takes the whole screen and your video shrinks to the corner while " +
      "it is up. The backend holds both columns — you only supply the headline, and the tool " +
      "result returns exactly what was placed on screen. Call this whenever the user asks about " +
      "Full mode, Lite mode, Avatar Only, the difference between the modes, or which one to use.",
    parameters: {
      headline: {
        type: "string",
        description: "Heading over the two cards, e.g. 'Two ways to run LiveAvatar'.",
      },
    },
    required: ["headline"],
    keys: ["headline"],
  },
  {
    name: "show_support_contact",
    description:
      "Show a clickable card with the LiveAvatar support email, pre-filled with the user's request " +
      "so they can send it in one click. Call this whenever the ask needs a human rather than " +
      "an answer — a refund, a billing dispute, custom avatar approval or moderation, account " +
      "or login trouble, an enterprise quote — and also when you genuinely do not know something " +
      "and are pointing them onward. Summarize what THEY asked, in their terms, so the draft " +
      "email reads like their request and not like your notes.",
    parameters: {
      summary: {
        type: "string",
        description:
          "What the user is asking for, in one or two sentences, written from their point of " +
          "view: 'I was charged twice for the Essential plan in March and would like a refund.'",
      },
      topic: {
        type: "string",
        description:
          "Short label for the request, used as the email subject line, e.g. 'Refund request' " +
          "or 'Custom avatar approval'. Optional.",
      },
    },
    required: ["summary"],
    keys: ["summary", "topic"],
  },
  {
    name: "hide_card",
    description:
      "Clear whatever card is on the user's screen and return the avatar to full frame. Cards " +
      "clear themselves when their animation ends, so only call this to take one down early.",
    parameters: {
      reason: { type: "string", description: "Why it is being cleared, one short phrase." },
    },
    required: ["reason"],
    keys: ["reason"],
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
