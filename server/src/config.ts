/**
 * Env-driven configuration. One `.env` at the repo root feeds everything —
 * the browser never sees any of it.
 *
 * GPT-Live is generally available; the model defaults to `gpt-live-1`.
 */

import { fileURLToPath } from "node:url";

// Loaded before anything reads process.env. Missing file is fine — deployed
// environments use real env vars.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* no .env — ambient env only */
}

const env = (name: string, fallback = ""): string =>
  process.env[name] ?? fallback;

export const config = {
  // 8788, not 8787: this demo runs a port up from the language-tutor demo
  // so both can be up at once. Mirrored in web/vite.config.ts.
  port: Number(env("PORT", "8788")),

  liveavatar: {
    apiUrl: env("LIVEAVATAR_API_URL", "https://api.liveavatar.com").replace(
      /\/+$/,
      "",
    ),
    apiKey: env("LIVEAVATAR_API_KEY"),
    /** Optional — empty means "pick the first public avatar" (liveavatar.ts). */
    avatarId: env("LIVEAVATAR_AVATAR_ID"),
  },

  gptlive: {
    apiKey: env("OPENAI_API_KEY"),
    model: env("GPT_LIVE_MODEL", "gpt-live-1"),
    voice: env("GPT_LIVE_VOICE", "marin"),
    responsesModel: env("GPT_LIVE_RESPONSES_MODEL", "gpt-5.4-nano"),
    /**
     * Set GPT_LIVE_DEBUG=1 to log every upstream event (audio payloads
     * elided). Loud — for answering "what did OpenAI actually send/reject",
     * not for leaving on.
     */
    debug: Boolean(env("GPT_LIVE_DEBUG")),
  },
};

/**
 * Names of required vars that are missing. Checked at boot (a warning) and at
 * `/api/session/start` (a 500 naming them) — not a crash, so `pnpm dev` works
 * before the `.env` is filled in and the failure explains itself.
 */
export function missingConfig(): string[] {
  const required: [string, string][] = [
    ["LIVEAVATAR_API_KEY", config.liveavatar.apiKey],
    ["OPENAI_API_KEY", config.gptlive.apiKey],
  ];
  return required.filter(([, value]) => !value).map(([name]) => name);
}
