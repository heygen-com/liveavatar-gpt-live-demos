/**
 * HTTP + WebSocket entrypoint.
 *
 *   POST /api/session/start  → mint + start a LITE session, spin up the legs
 *   POST /api/session/stop   → tear one down
 *   GET  /healthz
 *   WS   /ws/:sessionId      → the browser leg: mic audio up; transcripts,
 *                              tool visuals, and errors down
 *
 * In dev the web app runs on Vite (:5175) and proxies /api and /ws here, so
 * the browser sees one origin. In production this server also serves the built
 * frontend from web/dist.
 *
 * ⚠ No auth, on purpose — this is a local starter. Before exposing it
 * publicly, gate /api/session/start (any login) and the websocket upgrade
 * (a short-lived ticket minted by /start). See docs/ARCHITECTURE.md.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../../shared/messages";
import { config, missingConfig } from "./config";
import { LiveAvatarApiError, startSession as startUpstream } from "./liveavatar";
import { addSession, getSession, stopAll, stopSession } from "./registry";
import { Session } from "./session";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    console.error("[http] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && path === "/api/session/start") return handleStart(res);
  if (req.method === "POST" && path === "/api/session/stop") return handleStop(req, res);
  return serveStatic(res, path);
}

async function handleStart(res: ServerResponse): Promise<void> {
  const missing = missingConfig();
  if (missing.length > 0) {
    json(res, 500, { error: `missing env vars: ${missing.join(", ")} — copy .env.example to .env` });
    return;
  }
  try {
    const upstream = await startUpstream();
    const session = new Session(upstream.sessionId, upstream.wsUrl, (id) => {
      void stopSession(id, "leg_died");
    });
    addSession(session);
    session.start();
    console.log(`[http] session started: ${upstream.sessionId}`);
    json(res, 201, {
      session_id: upstream.sessionId,
      livekit_url: upstream.livekitUrl,
      livekit_client_token: upstream.livekitClientToken,
      // Relative on purpose: the browser dials the same origin it loaded from
      // (the Vite proxy in dev, this server in prod).
      ws_path: `/ws/${upstream.sessionId}`,
    });
  } catch (err) {
    // Verbatim upstream errors are the right DX for a local starter: "out of
    // credits" or "invalid avatar_id" should reach the person who can fix it.
    // (Production fronts this with its own API and hides the detail.)
    const message =
      err instanceof LiveAvatarApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "session start failed";
    console.error(`[http] session start failed: ${message}`);
    json(res, 502, { error: message });
  }
}

async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { session_id?: string };
  if (typeof body.session_id === "string") await stopSession(body.session_id, "client_stop");
  // Already-gone is success: the caller wanted it gone and it is gone.
  res.writeHead(204).end();
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = normalize(join(WEB_DIST, rel));
  if (!filePath.startsWith(normalize(WEB_DIST))) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) throw new Error("dir");
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(await readFile(filePath));
  } catch {
    // Overlay compositions must 404 rather than fall through to the app shell:
    // the hyperframes player would load index.html with a 200, find no
    // timeline, and report a generic timeout that looks like a broken
    // composition instead of a missing file.
    if (rel.startsWith("/overlays/")) {
      res.writeHead(404).end("composition not found");
      return;
    }
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(join(WEB_DIST, "index.html")));
    } catch {
      res.writeHead(404).end("not found — in dev, use the Vite server (pnpm dev)");
    }
  }
}

// ── browser websocket ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? "", "http://x").pathname);
  const session = match?.[1] ? getSession(match[1]) : undefined;
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One browser per session. The loser of a race (second tab, double click)
    // closes without entering the teardown below, so it cannot stop the
    // winner's session.
    if (!session.tryAttachFrontend(ws)) {
      ws.close(1008, "already connected");
      return;
    }
    console.log(`[ws] browser attached: ${session.sessionId}`);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "mic_audio" && typeof msg.audio === "string" && msg.audio) {
        session.sendMicAudio(msg.audio);
      } else if (msg.type === "stop") {
        ws.close(1000);
      }
    });

    ws.on("close", () => {
      session.detachFrontend(ws);
      // The browser leaving ends the session — there is no reconnect path, and
      // a session nobody is watching should not keep billing.
      void stopSession(session.sessionId, "frontend_disconnect");
    });
  });
});

// ── boot ──────────────────────────────────────────────────────────────────────

server.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(`[server] ⚠ missing env vars: ${missing.join(", ")} — sessions will not start`);
    console.warn("[server]   copy .env.example to .env at the repo root and fill it in");
  }
});

// Sessions live in this process; a shutdown is the end of them. Stop them
// upstream on the way out rather than leaving them to the billing clock.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopAll().finally(() => process.exit(0));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
