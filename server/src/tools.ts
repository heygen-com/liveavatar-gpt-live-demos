/**
 * The tool dispatcher: turns one finished tool call into the `ui` message the
 * browser renders.
 *
 * Values come from a model, so they are untrusted: clamp lengths here, and
 * render with textContent only on the client. The prompts that make the models
 * call these tools live in prompts.ts.
 *
 * `learnedWords` is the session's running record of every term card shown
 * (kept by session.ts). The recap tool renders FROM that store — the model
 * asks for the recap but never supplies the list, so it cannot misremember,
 * invent, or drop words.
 */

import type { TermCardProps, UiMessage } from "../../shared/messages";
import { inferToolName } from "../../shared/tools";

// Recap cap when the model asks for the panel: the last 8 words taught.
// Rows past this stop being readable at 1080p anyway; the every-few-words
// rolling recap (session.ts) shows a smaller window still.
const MAX_RECAP_WORDS = 8;

export function dispatchToolCall(
  name: string | null,
  args: Record<string, unknown>,
  learnedWords: readonly TermCardProps[],
): UiMessage | null {
  const resolved = name || inferToolName(args);
  if (!resolved) return null;

  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };

  switch (resolved) {
    case "show_term_card": {
      const term = text(args.term, 60);
      if (!term) return null;
      const props: TermCardProps = { term };
      const reading = text(args.reading, 80);
      const meaning = text(args.meaning, 120);
      if (reading) props.reading = reading;
      if (meaning) props.meaning = meaning;
      return { widget: "term_card", props };
    }
    case "show_learned_words": {
      // Nothing taught yet — nothing to recap. Dropping beats an empty panel.
      if (learnedWords.length === 0) return null;
      return {
        widget: "learned_words",
        props: {
          title: text(args.title, 60) ?? "Words so far",
          words: learnedWords.slice(-MAX_RECAP_WORDS),
        },
      };
    }
    case "hide_card":
      return { widget: "hide", props: {} };
    default:
      return null;
  }
}
