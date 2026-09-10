/**
 * Every piece of model-facing text, in one place.
 *
 * Two kinds live here, and the split is the point:
 *
 * - **Persona** — who the avatar is and how it opens. Loaded from the markdown
 *   files in `server/prompts/`, which is where you customize this demo: edit
 *   `instructions.md` and `greeting.md` and restart. (The `GPT_LIVE_*` env
 *   vars override even those.)
 * - **Mechanics** — the directives that make delegation and tools work at all.
 *   These are wiring, not flavor: change them and visuals stop appearing or
 *   the avatar starts narrating its own tool calls. They stay in code.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function promptFile(name: string, fallback: string): string {
  try {
    return readFileSync(
      fileURLToPath(new URL(`../prompts/${name}`, import.meta.url)),
      "utf8",
    ).trim();
  } catch {
    return fallback;
  }
}

// ── persona (edit server/prompts/*.md, not these fallbacks) ──────────────────

export const DEFAULT_INSTRUCTIONS = promptFile(
  "instructions.md",
  "You are a friendly avatar presenter in a live voice conversation. Keep every reply casual and " +
    "natural. Never use lists, markdown, or formatting: everything you pronounce is spoken aloud.",
);

export const DEFAULT_GREETING = promptFile(
  "greeting.md",
  "Say hello, introduce yourself in one sentence, and invite them to ask about anything.",
);

// ── mechanics ─────────────────────────────────────────────────────────────────

// The v3 speak-first mechanism: one `session.instructions.append` carrying an
// explicit speak-now directive plus the opening (OpenAI's tested phrasing —
// 500/500 sessions spoke first). `response.create` is a backend command in
// this API and never starts a voice turn. Whole append must stay under 500
// tokens, greeting.md included.
export const GREETING_PREAMBLE =
  "The session just started. The user is listening but has not spoken yet. " +
  "Immediately speak first to open the conversation; do not wait for the user to speak. " +
  "After the opening, pause and listen. Opening: ";

// Unblocks a client-target delegation. This starter runs in responses mode
// and should never see one; if one arrives the model is blocked waiting on
// us, so answer rather than let the session freeze on "one sec".
export const CLIENT_DELEGATION_STUB =
  "(No additional information available; answer directly and briefly.)";

/**
 * Appended to the live model's instructions. Delegation steering lives HERE,
 * at startup — not in mid-session appends. Measured, twice: prose asking the
 * live model to delegate its own teaching moments never fired once
 * (backend_model_usage: []), while an explicit learner request ("teach me the
 * word for respect") delegated instantly. So the directive claims only the
 * trigger that works. Mid-session appends are avoided for pacing too: an
 * append lands as new context the model acts on IMMEDIATELY, cutting off
 * whatever practice loop it was running.
 */
export const LIVE_DIRECTIVE =
  "\n\nOn-screen visuals: you cannot draw anything on the learner's screen yourself. Cards appear " +
  "alongside your teaching on their own, and your backend produces one whenever you hand a turn " +
  "to it. Whenever the learner asks for a word, phrase, or translation, delegate that turn to " +
  "your backend and let it answer. " +
  "Delegating never means pausing: keep talking naturally, and let the visual simply appear " +
  "alongside your speech — never wait in silence, and never say fillers like 'one moment'. " +
  "Never say that a visual has appeared or is appearing — no 'here you go', 'take a look', or " +
  "'see it on your screen' — and never claim you are preparing one. " +
  "Above all, never go silent: if you are ever unsure what to do, keep the conversation moving " +
  "out loud — silence is the one failure the learner cannot recover from.";

/**
 * Instructions for the delegated Responses model — the one that holds the
 * tools. The "answer in words AND call the tool in the same reply" clause is
 * load-bearing: a tool-only reply leaves the avatar silent while the live
 * voice waits on the delegation.
 */
export const RESPONSES_INSTRUCTIONS =
  "ALWAYS answer in words as well as calling tools. Your reply text is what the avatar speaks " +
  "aloud, so a reply that is only a tool call leaves the learner in silence. Every reply must " +
  "contain the spoken answer AND the tool call, in that same reply; a tool call with no text is " +
  "an error. " +
  // The tools themselves are REGISTERED via delegation.responses.tools with
  // full schemas and descriptions (shared/tools.ts) — never re-listed here.
  // This prompt only carries the behavioral rules the schemas cannot.
  "You are the translator behind a live Japanese tutor avatar, and the only part of it that can " +
  "put anything on the learner's screen — your tools are the only way. " +
  "The most common request: the learner names an English word or phrase they want in Japanese. " +
  "Answer it directly — give the Japanese and say it twice, slowly — and call show_term_card in " +
  "the same reply: the word in Japanese script (term), a syllable-hyphenated romaji reading, and " +
  "a short English meaning. " +
  "MANDATORY: whenever you teach, translate, explain, or correct a word or phrase, call " +
  "show_term_card in THIS reply — there is no other way for it to appear on screen, and seeing " +
  "the word while hearing it is how it sticks. Prefer one card per word; never two cards in the " +
  "same reply. " +
  "Call show_learned_words when the learner asks what they have covered so far, or when a review " +
  "break is called for. Pass only the heading — its tool result returns the exact words now on " +
  "the panel; walk through THOSE words out loud, briefly. Never answer a request for a new word " +
  "with show_learned_words. " +
  "Speak plainly for listening — one or two sentences, no formatting.";

// ── lesson script ─────────────────────────────────────────────────────────────

/**
 * The opening curriculum. The whole plan is stated ONCE, in the startup
 * instructions (LESSON_DIRECTIVE below) — the model owns the pacing from
 * there. It used to be prompted one word at a time with mid-session appends,
 * and that broke the conversation cycle: an append lands as new context the
 * model acts on immediately, so "say it again: こんにちは" became "Now, goodbye
 * is さようなら" in the same breath, the practice loop cut off mid-word.
 *
 * The card data is here because the SERVER pushes each term card when the
 * tutor is heard saying the word (session.ts) — the model is never asked to
 * delegate for words we already hold. Measured, not assumed: a full session
 * of "delegate this teaching" prompts closed with `backend_model_usage: []`.
 * GPT-Live's delegation is trained for capability gaps (current information,
 * deep reasoning), and teaching "hello" is within its own ability, so it
 * answers directly no matter what the prose says.
 */
export interface LessonWord {
  english: string;
  term: string;
  reading: string;
  meaning: string;
}

export const LESSON_WORDS: readonly LessonWord[] = [
  {
    english: "Hello",
    term: "こんにちは",
    reading: "kon-ni-chi-wa",
    meaning: "hello",
  },
  {
    english: "Goodbye",
    term: "さようなら",
    reading: "sa-yo-u-na-ra",
    meaning: "goodbye",
  },
  {
    english: "Thank you",
    term: "ありがとう",
    reading: "a-ri-ga-tou",
    meaning: "thank you",
  },
];

/**
 * The lesson plan as startup instructions, appended after LIVE_DIRECTIVE
 * (gptlive.ts). Pacing rules are explicit — one word per turn, wait for the
 * echo — because the model owns the cycle now and nothing will correct it
 * mid-session.
 */
export const LESSON_DIRECTIVE =
  "\n\nToday's lesson plan, in order: " +
  LESSON_WORDS.map(
    (w, i) => `${i + 1}. ${w.english} — ${w.term} (${w.reading})`,
  ).join("; ") +
  ". " +
  "Greet the learner as your opening line directs, and once they respond, begin with word 1. " +
  "Teach ONE word per turn: say it slowly, " +
  "twice, then have the learner say it back and correct them gently. If you're waiting for the learner" +
  "to say it, add in your response: 'try saying it again to really nail it down.'" +
  "Try to avoid ending a turn without giving the learner something to do. Move to the next word only " +
  "after they have tried the current one — never introduce two new words in the same turn. " +
  "When all three are done, tell the learner they can now name ANY word or phrase they would " +
  "like to hear in Japanese, and ask for their first one. From that point on you are a " +
  "translator: every time they name a word or phrase, delegate that turn to your backend, which " +
  "translates and answers — then have them say the Japanese back.";

/**
 * Instruction append when nobody has said anything for a while (the silence
 * watchdog in session.ts). Kills the flow "Avatar: yep, I hear you. — You:
 * why aren't you saying anything?"
 */
export const SILENCE_CHECKIN =
  "Nobody has spoken for a while. Whatever you were waiting for — the learner to finish, a " +
  "delegation to come back, your turn — stop waiting and speak RIGHT NOW. Re-engage the learner " +
  "briefly and warmly: ask if they are still there, encourage them — 'you've got this' — or say " +
  "the current word again and invite them to try it. Never leave the room silent.";

/**
 * Instruction append that triggers the periodic review via DELEGATION
 * (session.ts, every RECAP_EVERY_WORDS new words). Deliberately carries no
 * word list: the backend's show_learned_words call renders the panel, and its
 * tool result hands back the exact words on it — so the walkthrough is
 * synchronized with the screen by the conversation itself, not by a timer
 * guessing at speech cadence. A fallback in session.ts pushes the panel
 * directly if the model never delegates.
 */
export const REVIEW_BREAK_PROMPT =
  "Time for a short review break. Finish the current exchange first — if you just asked the " +
  "learner to say a word back, respond to their attempt before anything else. Then announce the " +
  "break in your own words, something in the spirit of: 'let's take a quick break — I'll pull up " +
  "the cards we've seen so far', and hand this turn to your backend: it will put the review on " +
  "screen and return the exact words to walk through. This review is the ONE time you may " +
  "mention the cards on screen. Afterwards, pick the conversation back up where you left off.";

// followUpSpeech (the silent-tool-call safety net) is gone on purpose: tool
// results are returned via response.item.create + response.create, and
// the backend CONTINUES its reply after receiving them — its own continuation
// is the speech the safety net used to fake, and both firing would
// double-speak.
