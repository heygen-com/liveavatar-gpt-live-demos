#!/usr/bin/env node
/**
 * Preflight for `pnpm dev` / `pnpm start`: refuse to boot with required env
 * missing, naming exactly what's absent and how to fix it — instead of a
 * server that starts fine and then 500s on the first session.
 *
 * The required list mirrors `missingConfig()` in server/src/config.ts — keep
 * the two in sync.
 */
import { fileURLToPath } from "node:url";

// Same file the server loads. Missing is fine — deployed environments use
// real env vars, which the check below still sees.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env — ambient env only */
}

const required = ["LIVEAVATAR_API_KEY", "OPENAI_API_KEY"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(
    `\n\x1b[31mMissing required env:\x1b[0m ${missing.join(", ")}\n\n` +
      "Run \x1b[1mpnpm run setup\x1b[0m — it prompts for each key, verifies it, and writes .env.\n" +
      "Or copy .env.example to .env at the repo root and fill it in by hand.\n",
  );
  process.exit(1);
}
