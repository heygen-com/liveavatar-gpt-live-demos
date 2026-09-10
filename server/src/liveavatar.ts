/**
 * HTTP wrapper over the LiveAvatar API session endpoints. One function per
 * endpoint, no product logic.
 *
 * LITE mode is the whole trick: it gives back a `ws_url` — a direct websocket
 * into the avatar's media server — so this server can thread GPT-Live's audio
 * straight into the avatar without the browser in the loop. The browser only
 * receives the LiveKit credentials and watches.
 */

import { config } from "./config";

export interface StartedSession {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  /** The media-server websocket this server threads audio into. */
  wsUrl: string;
}

export class LiveAvatarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LiveAvatar API returned ${status}: ${body}`);
  }
}

async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.liveavatar.apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new LiveAvatarApiError(response.status, text.slice(0, 500));
  const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
  return parsed.data ?? {};
}

// Resolved once per process: which avatar to drive when LIVEAVATAR_AVATAR_ID
// is not set. `avatar_id` is required by the API with no server-side default,
// but `GET /v1/avatars/public` needs no auth — so the zero-config path is
// "the first active public avatar", named in the log so it is not a mystery.
let fallbackAvatarId: string | null = null;

async function resolveAvatarId(): Promise<string> {
  if (config.liveavatar.avatarId) return config.liveavatar.avatarId;
  if (fallbackAvatarId) return fallbackAvatarId;

  const response = await fetch(`${config.liveavatar.apiUrl}/v1/avatars/public?page_size=20`);
  if (!response.ok) throw new Error(`could not list public avatars (${response.status})`);
  const body = (await response.json()) as {
    data?: { results?: { id?: string; name?: string; status?: string; type?: string }[] };
  };
  const avatars = body.data?.results ?? [];
  const pick =
    avatars.find((a) => a.status === "ACTIVE" && a.type === "VIDEO") ??
    avatars.find((a) => a.status === "ACTIVE");
  if (!pick?.id) {
    throw new Error("no public avatar available — set LIVEAVATAR_AVATAR_ID in .env");
  }
  console.log(`[liveavatar] no LIVEAVATAR_AVATAR_ID set — using public avatar "${pick.name}" (${pick.id})`);
  fallbackAvatarId = pick.id;
  return pick.id;
}

/**
 * Mint + start one LITE session.
 *
 * The token payload deliberately carries no `*_config` block: `livekit_config`
 * would mean bring-your-own-LiveKit and would null out the `livekit_url` /
 * `livekit_client_token` the browser needs back from start. A bare LITE
 * payload returns those plus `ws_url`.
 */
export async function startSession(): Promise<StartedSession> {
  const token = await post(
    "/v1/sessions/token",
    {
      mode: "LITE",
      avatar_id: await resolveAvatarId(),
    },
    { "X-API-KEY": config.liveavatar.apiKey },
  );
  const sessionId = String(token.session_id ?? "");
  const sessionToken = String(token.session_token ?? "");
  if (!sessionId || !sessionToken) {
    throw new Error("LiveAvatar token mint returned no session_id/session_token");
  }

  const started = await post(
    "/v1/sessions/start",
    {},
    { Authorization: `Bearer ${sessionToken}` },
  );
  const livekitUrl = String(started.livekit_url ?? "");
  const livekitClientToken = String(started.livekit_client_token ?? "");
  const wsUrl = String(started.ws_url ?? "");
  if (!livekitUrl || !livekitClientToken || !wsUrl) {
    // A LITE start without an agent config returns all three; missing any
    // means the payload drifted. Fail loudly rather than hand out a session
    // the legs cannot work with — but release the upstream slot first.
    await stopSession(sessionId).catch(() => {});
    throw new Error(`session ${sessionId} started without livekit_url/livekit_client_token/ws_url`);
  }

  return { sessionId, livekitUrl, livekitClientToken, wsUrl };
}

/**
 * Uses the API-key form rather than the session JWT: teardown can happen well
 * after mint, and this way it does not depend on the JWT still being valid.
 */
export async function stopSession(sessionId: string): Promise<void> {
  await post(
    "/v1/sessions/stop",
    { session_id: sessionId },
    { "X-API-KEY": config.liveavatar.apiKey },
  );
}
