#!/usr/bin/env node
/**
 * First-run setup: collect the two API keys — the only required config —
 * verify each against the live API, and write them to `.env`.
 *
 *   pnpm run setup
 *
 * Safe to re-run: anything already in `.env` (or the ambient environment) is
 * kept and re-verified, not re-asked. If `.env` doesn't exist it is seeded
 * from `.env.example` first, so every documented variable and its comments
 * survive.
 *
 * Nothing is created or registered anywhere — one read-only GET per key to
 * verify it, then a local write to `.env`.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, env as ambient } from "node:process";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const ENV_TEMPLATE = fileURLToPath(new URL("../.env.example", import.meta.url));
const LIVEAVATAR_API_BASE = "https://api.liveavatar.com";
const OPENAI_API_BASE = "https://api.openai.com";

// Not prompted for — filled in silently when absent so the preflight
// (scripts/check-env.mjs) passes, and listed in the closing reminders.
// Mirrored from .env.example.
const DEFAULT_GPT_LIVE_MODEL = "gpt-live-1";

// The default avatar for a fresh setup. Also filled in only when absent —
// an id already in .env is never overwritten.
const DEFAULT_AVATAR_ID = "65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green("✓")} ${s}`);
const info = (s) => console.log(`  ${c.dim("·")} ${c.dim(s)}`);
const warn = (s) => console.log(`  ${c.yellow("!")} ${s}`);

// Prompts only work on a TTY. Piped/CI runs fall back to defaults, and a
// missing required key becomes a clean failure instead of a hang.
const interactive = stdin.isTTY === true;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
const ask = async (q, fallback = "") =>
  rl ? (await rl.question(q)).trim() || fallback : fallback;

/**
 * Parse `.env` into a map. Values may be quoted or carry a trailing
 * `# comment`; an unquoted value is cut at the first whitespace-preceded hash
 * so a bare `#` inside a secret is left alone.
 */
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    const quoted = /^(["'])(.*)\1/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else if (value.startsWith("#")) {
      value = ""; // the whole "value" is an inline comment on an unset key
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Merge keys into `.env`, rewriting existing lines in place and appending the
 * rest. Never drops unrelated lines or comments.
 */
function writeEnvFile(updates) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const remaining = { ...updates };
  const rewritten = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in remaining) {
      const key = m[1];
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });
  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  if (appended.length) {
    if (rewritten.at(-1)?.trim() !== "") rewritten.push("");
    rewritten.push("# Added by `pnpm run setup`", ...appended, "");
  }
  writeFileSync(ENV_PATH, rewritten.join("\n"));
}

/**
 * Resolve one key: `.env` → environment → prompt, verified before it is
 * accepted. A rejected key gets re-prompted (interactive) or fails the run.
 */
async function resolveVerifiedKey({ label, envName, current, hint, verify }) {
  let value = current || ambient[envName] || "";
  let source = current ? "from .env" : value ? "from environment" : "will be saved";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!value) {
      value = await ask(`  Paste your ${label}: `);
      source = "will be saved";
    }
    if (!value) {
      console.error(`\n${c.red(`  No ${label} given.`)}\n  ${hint}\n`);
      exit(1);
    }
    const problem = await verify(value);
    if (!problem) {
      ok(`key verified ${c.dim(`(${source})`)}`);
      return value;
    }
    warn(problem);
    if (!interactive) exit(1);
    value = "";
  }
  console.error(`\n${c.red("  Giving up after three attempts.")}\n  ${hint}\n`);
  exit(1);
}

async function main() {
  console.log(`\n${c.bold("LiveAvatar × GPT-Live — setup")}\n`);

  // Seed from the template so the operator ends up with every documented var
  // and its comments, not just the handful this script fills in.
  if (!existsSync(ENV_PATH) && existsSync(ENV_TEMPLATE)) {
    copyFileSync(ENV_TEMPLATE, ENV_PATH);
    ok("created .env from .env.example");
    console.log("");
  }

  const env = readEnvFile();
  const laBase = (env.LIVEAVATAR_API_URL || ambient.LIVEAVATAR_API_URL || LIVEAVATAR_API_BASE)
    .replace(/\/+$/, "");

  // ── 1. LiveAvatar API key ──────────────────────────────────────────────────
  console.log(c.bold("1. LiveAvatar API key"));
  info("create one at https://app.liveavatar.com/developers");
  const liveavatarKey = await resolveVerifiedKey({
    label: "LiveAvatar API key",
    envName: "LIVEAVATAR_API_KEY",
    current: env.LIVEAVATAR_API_KEY,
    hint: "Create one at https://app.liveavatar.com/developers, then re-run `pnpm run setup`.",
    verify: async (key) => {
      try {
        const res = await fetch(`${laBase}/v1/avatars?page_size=1`, {
          headers: { "X-API-KEY": key },
        });
        if (res.ok) return null;
        return res.status === 401 || res.status === 403
          ? "that key was rejected — check it at https://app.liveavatar.com/developers"
          : `LiveAvatar API answered ${res.status} — try again in a moment`;
      } catch (err) {
        return `could not reach ${laBase} — ${err.message}`;
      }
    },
  });

  // ── 2. OpenAI API key ──────────────────────────────────────────────────────
  console.log(c.bold("\n2. OpenAI API key"));
  info("create one at https://platform.openai.com/api-keys");
  const openaiKey = await resolveVerifiedKey({
    label: "OpenAI API key",
    envName: "OPENAI_API_KEY",
    current: env.OPENAI_API_KEY,
    hint: "Create one at https://platform.openai.com/api-keys, then re-run `pnpm run setup`.",
    verify: async (key) => {
      try {
        const res = await fetch(`${OPENAI_API_BASE}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) return null;
        return res.status === 401
          ? "that key was rejected — check it at https://platform.openai.com/api-keys"
          : `OpenAI API answered ${res.status} — try again in a moment`;
      } catch (err) {
        return `could not reach ${OPENAI_API_BASE} — ${err.message}`;
      }
    },
  });

  writeEnvFile({
    LIVEAVATAR_API_KEY: liveavatarKey,
    OPENAI_API_KEY: openaiKey,
    // Required by the server but never worth a prompt — the default works.
    // Only filled in when absent, so a hand-edited value survives re-runs.
    ...(env.GPT_LIVE_MODEL ? {} : { GPT_LIVE_MODEL: DEFAULT_GPT_LIVE_MODEL }),
    ...(env.LIVEAVATAR_AVATAR_ID ? {} : { LIVEAVATAR_AVATAR_ID: DEFAULT_AVATAR_ID }),
  });

  console.log(`\n${c.green("Done.")} Wrote .env — that's everything required.`);
  console.log(`Run ${c.bold("pnpm dev")} and open http://localhost:5174\n`);
  console.log(c.bold("Next steps, try playing around with these"));
  info(`GPT_LIVE_MODEL         ${env.GPT_LIVE_MODEL || DEFAULT_GPT_LIVE_MODEL} — swap in .env`);
  info(
    `LIVEAVATAR_AVATAR_ID   ${env.LIVEAVATAR_AVATAR_ID || DEFAULT_AVATAR_ID} — swap in .env`,
  );
  info("server/prompts/*.md    the persona — who the avatar is and how it opens");
  info("more knobs (voice, port, debug) are documented in .env.example");
  console.log("");
}

main()
  .catch((err) => {
    console.error(`\n${c.red("Setup failed:")} ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl?.close());
