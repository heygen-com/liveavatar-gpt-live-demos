/**
 * The tool dispatcher: turns one finished tool call into the `ui` message the
 * browser renders.
 *
 * Values come from a model, so they are untrusted: clamp lengths here, and
 * render with textContent only on the client. The prompts that make the models
 * call these tools live in prompts.ts.
 *
 * PRICING and MODES are the server-owned truth their panels render FROM — the
 * model asks for a panel but never supplies a number or a capability, so it
 * cannot misquote, invent, or round one. SUPPORT_EMAIL is the same idea for
 * an address: a hallucinated support inbox sends the user's refund request
 * into the void. Change a fact here AND in the spoken knowledge base
 * (server/prompts/knowledge.md), then restart.
 */

import type {
  ModeColumn,
  PricingRow,
  SupportContactProps,
  UiMessage,
} from "../../shared/messages";
import { inferToolName } from "../../shared/tools";

/** The plan table — the only place prices exist on the render path. */
export const PRICING: { rows: PricingRow[]; footnote: string } = {
  rows: [
    {
      plan: "Free",
      price: "$0 / mo",
      detail: "10 credits · 2-minute sessions · preset avatars, watermarked.",
    },
    {
      plan: "Starter",
      price: "$19 / mo",
      detail: "200 credits · 5-minute sessions · pay-as-you-go unlocked.",
    },
    {
      plan: "Essential",
      price: "$99 / mo",
      detail: "1,100 credits · 20-minute sessions · no watermark · one 720p custom avatar included.",
    },
    {
      plan: "Business",
      price: "$475 / mo",
      detail: "6,000 credits · 60-minute sessions · one 1080p custom avatar included.",
    },
  ],
  // One line: the sheet's footnote is single-line, a longer one is clipped.
  // Enterprise is deliberately not a row (custom pricing, nothing to show);
  // the spoken knowledge (prompts/knowledge.md) still covers it.
  footnote: "1 credit = 30s Full / 1 min Lite · no concurrency limits · overage $0.10/credit from Essential.",
};

/**
 * The mode comparison — server truth for both columns.
 *
 * The two columns deliberately carry the SAME `parts` labels in the same
 * order: the visual argument is the row-by-row contrast between "we run
 * this" and "you bring this", and that only reads if the rows line up.
 */
export const MODES: { full: ModeColumn; lite: ModeColumn } = {
  full: {
    name: "FULL Mode",
    tagline: "LiveAvatar runs the whole pipeline.",
    price: "2 credits / minute",
    parts: [
      { label: "Speech recognition", value: "Deepgram · AssemblyAI", included: true },
      { label: "Language model", value: "GPT-4o mini (or bring your own)", included: true },
      { label: "Text to speech", value: "ElevenLabs Flash v2.5", included: true },
      { label: "Avatar rendering", value: "Included", included: true },
      { label: "Custom avatar voice", value: "Applied automatically", included: true },
      { label: "Session data storage", value: "Yes", included: true },
    ],
    bestFor: "Best for a quick end-to-end integration.",
  },
  lite: {
    name: "Avatar Only (LITE)",
    tagline: "You bring the voice agent; we render the face.",
    price: "1 credit / minute",
    parts: [
      { label: "Speech recognition", value: "You wire up your own", included: false },
      { label: "Language model", value: "You wire up your own", included: false },
      { label: "Text to speech", value: "You wire up your own", included: false },
      { label: "Avatar rendering", value: "Included", included: true },
      { label: "Custom avatar voice", value: "You send the audio", included: false },
      { label: "Session data storage", value: "No", included: false },
    ],
    bestFor: "Best for custom RAG, multi-language, and platform builders.",
  },
};

/** Where a hand-off goes. Never a model argument — see the header. */
export const SUPPORT_EMAIL = "support@liveavatar.com";

export function dispatchToolCall(
  name: string | null,
  args: Record<string, unknown>,
): UiMessage | null {
  const resolved = name || inferToolName(args);
  if (!resolved) return null;

  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };

  switch (resolved) {
    case "show_pricing_sheet":
      // The model supplies the heading and nothing else; rows and footnote
      // come from the server's table above.
      return {
        widget: "pricing_sheet",
        props: {
          title: text(args.title, 60) ?? "LiveAvatar pricing",
          rows: PRICING.rows,
          footnote: PRICING.footnote,
        },
      };
    case "show_mode_comparison":
      // Headline only; both columns come from MODES above.
      return {
        widget: "mode_comparison",
        props: {
          headline: text(args.headline, 60) ?? "Two ways to run LiveAvatar",
          full: MODES.full,
          lite: MODES.lite,
        },
      };

    case "show_support_contact": {
      // The model supplies the user's ask; the server owns the address and
      // assembles the mailto so a malformed draft can't become a bad link.
      const summary = text(args.summary, 600);
      if (!summary) return null; // nothing to put in the email → no card
      const topic = text(args.topic, 60) ?? "LiveAvatar support request";
      const props: SupportContactProps = {
        title: "Email LiveAvatar support",
        email: SUPPORT_EMAIL,
        note: "This one needs a human. Click the card to open a pre-filled email.",
        subject: topic,
        body: `${summary}\n\n— Sent from the LiveAvatar support avatar`,
      };
      return { widget: "support_contact", props };
    }

    case "hide_card":
      return { widget: "hide", props: {} };
    default:
      return null;
  }
}
