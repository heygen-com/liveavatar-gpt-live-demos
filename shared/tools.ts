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

/** Args for `show_term_card`, as the dispatcher receives them (unvalidated). */
export interface ShowTermCardArgs {
  term: string;
  reading?: string;
  meaning?: string;
}

/** Args for `show_learned_words`. The word list itself is server state. */
export interface ShowLearnedWordsArgs {
  title: string;
}

/** Args for `hide_card`. */
export interface HideCardArgs {
  reason: string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "show_term_card",
    description:
      "Put an animated card on the learner's screen showing a term, its pronunciation, and its " +
      "meaning — a lower-third over your video. The default way to reinforce a word or phrase " +
      "you are teaching out loud, in any language.",
    parameters: {
      term: {
        type: "string",
        description: "The word or phrase itself, in its own script: こんにちは, お茶, 'mellifluous'.",
      },
      reading: {
        type: "string",
        description:
          "How it is pronounced, hyphenated by syllable so an English speaker can read it aloud: " +
          "'kon-ni-chi-wa'. Optional.",
      },
      meaning: {
        type: "string",
        description: "Short English definition or gloss, e.g. 'hello' or 'green tea'. Optional.",
      },
    },
    required: ["term"],
    keys: ["term", "reading", "meaning"],
  },
  {
    name: "show_learned_words",
    description:
      "Show the recap panel: recently taught words with pronunciations and meanings. The panel " +
      "takes the whole screen and your video shrinks to the corner while it is up. The backend " +
      "already remembers the words — you only supply the heading, and the tool result returns the " +
      "exact words placed on the panel. Call this when the learner asks what they have covered so " +
      "far, or when a review break is called for; never in response to a request for a new word " +
      "or a translation.",
    parameters: {
      title: {
        type: "string",
        description: "Heading for the panel, e.g. 'Words so far' or 'Your first five words'.",
      },
    },
    required: ["title"],
    keys: ["title"],
  },
  {
    name: "hide_card",
    description:
      "Clear whatever card is on the learner's screen and return the avatar to full frame. Cards " +
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
