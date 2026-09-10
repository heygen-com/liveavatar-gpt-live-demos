/**
 * In-memory registry of live sessions, plus the watchdog that reaps them.
 *
 * Single process by design: a plain Map is the whole story, and a restart
 * drops live sessions. Fine for a starter — see docs/ARCHITECTURE.md for what
 * production adds.
 */

import { stopSession as stopUpstream } from "./liveavatar";
import { Session } from "./session";

const WATCHDOG_TICK_MS = 5_000;

// No mic audio for this long → tear the session down. Mic audio is the only
// liveness signal on purpose: the browser's capture has no VAD, so an attached
// browser streams frames continuously even through silence. What this reaps is
// a session whose browser is attached but sending nothing (mic denied, capture
// died) — exactly a session nobody can use and nobody should pay for. A
// browser that DISCONNECTS is handled immediately by the ws endpoint instead.
const IDLE_TIMEOUT_MS = 60_000;

const sessions = new Map<string, Session>();

export function addSession(session: Session): void {
  sessions.set(session.sessionId, session);
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/**
 * Tear a session down. Idempotent: the Map delete is the claim, so a browser
 * stop racing the watchdog runs exactly once.
 */
export async function stopSession(sessionId: string, reason: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  console.log(`[registry] stopping ${sessionId.slice(0, 8)} (${reason}, ${sessions.size} live)`);
  // Legs first, so GPT-Live gets its session.close and the avatar finishes its
  // word rather than being cut off underneath.
  await session.stop().catch(() => {});
  await stopUpstream(sessionId).catch((err: unknown) => {
    console.warn(`[registry] upstream stop failed for ${sessionId}: ${err}`);
  });
  return true;
}

/** Best-effort teardown of everything still live, on process exit. */
export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id, "shutdown")));
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivityAt >= IDLE_TIMEOUT_MS) {
      void stopSession(session.sessionId, "idle");
    }
  }
}, WATCHDOG_TICK_MS).unref();
