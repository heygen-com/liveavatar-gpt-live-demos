/**
 * Owns one session end to end: start → LiveKit join → websocket → mic, and the
 * teardown of all four in the right order.
 *
 * Ordering matters on the way up: the mic only starts once the server says
 * `ready`, because audio sent before GPT-Live's session exists is discarded.
 *
 * Startup is guarded by a generation counter: every await below is a window in
 * which the user can hit Stop or the socket can drop, and a stale start must
 * not re-attach resources that teardown already released.
 */

// Registers the <hyperframes-player> custom element used for overlays.
import "@hyperframes/player";
import type { Turn } from "../../shared/messages";
import { joinAvatarRoom, type AvatarRoom } from "./livekitRoom";
import { startMicCapture, type MicCapture } from "./micCapture";
import { createOverlays } from "./overlays/index";
import { getPokerTheme, setPokerTheme, type PokerTheme } from "./overlays/pokerTable";
import { openSessionSocket, type SessionSocket } from "./socket";

const video = document.getElementById("video") as HTMLVideoElement;
const audio = document.getElementById("audio") as HTMLAudioElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const player = document.getElementById("overlay-player") as HTMLElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const transcriptEl = document.getElementById("transcript") as HTMLDivElement;
const loaderLabel = document.getElementById("loader-label") as HTMLSpanElement;
const micBtn = document.getElementById("mic") as HTMLButtonElement;

type StatusKind = "idle" | "busy" | "live" | "error";
const setStatus = (msg: string, kind: StatusKind = "idle") => {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
  // The in-stage loader narrates the same steps while the video is still dark.
  if (stage.dataset.state === "connecting") loaderLabel.textContent = msg;
};

/** idle → hero visible; connecting → loader; live → video (see index.html). */
const setStage = (state: "idle" | "connecting" | "live") => {
  stage.dataset.state = state;
};

const overlays = createOverlays({ stage, player, onStatus: (msg) => setStatus(msg, "error") });

// Table-theme selector: persists the choice and re-skins a live table in
// place (pokerTable.ts). Options mirror POKER_THEMES, so the cast is safe.
const themeSelect = document.getElementById("theme-select") as HTMLSelectElement;
themeSelect.value = getPokerTheme();
themeSelect.addEventListener("change", () => setPokerTheme(themeSelect.value as PokerTheme));

// ── transcript ────────────────────────────────────────────────────────────────
// One line per turn, keyed by turn id: streaming updates rewrite the line in
// place, and a new id starts a new line.

const turnLines = new Map<string, { line: HTMLDivElement; text: HTMLSpanElement }>();
let lastAssistantLine: HTMLDivElement | null = null;

function upsertTurn(turn: Turn): void {
  let entry = turnLines.get(turn.id);
  if (!entry) {
    const line = document.createElement("div");
    line.className = `turn ${turn.role}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = turn.role === "user" ? "You" : "Avatar";
    const text = document.createElement("span");
    text.className = "text";
    line.append(who, text);
    transcriptEl.appendChild(line);
    entry = { line, text };
    turnLines.set(turn.id, entry);
  }
  entry.text.textContent = turn.text;
  if (turn.role === "assistant") lastAssistantLine = entry.line;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── liveness ──────────────────────────────────────────────────────────────────
// Two indicators, one rAF loop: the mic meter is fed by the capture path
// (micCapture's onLevel — the meter shows exactly what ships), and the
// speaking glow is measured off the avatar's LiveKit audio with an
// AnalyserNode listening alongside the element, which keeps playing untouched.

// Mic bars: a frequency visualizer on the button's canvas — each bar averages
// a slice of the analyser's FFT (speech band), redrawn every frame. Muting
// flattens it on its own — the disabled track renders silence into the
// analyser (see micCapture).
const waveCanvas = micBtn.querySelector(".wave") as HTMLCanvasElement;
const waveCtx = waveCanvas.getContext("2d") as CanvasRenderingContext2D;
let micAnalyser: AnalyserNode | null = null;
let micFreqBuf: Uint8Array<ArrayBuffer> | null = null;

const BAR_COUNT = 7;
const BINS_PER_BAR = 6; // fftSize 512 @ 48k → ~94Hz/bin: 7×6 bins ≈ 0–4kHz, the speech band

function drawMicWave(): void {
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  waveCtx.clearRect(0, 0, w, h);
  const live = micAnalyser && micFreqBuf && !micMuted;
  if (live) {
    micAnalyser!.getByteFrequencyData(micFreqBuf!);
    const grad = waveCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#b98cff");
    grad.addColorStop(1, "#6ea8ff");
    waveCtx.fillStyle = grad;
  } else {
    waveCtx.fillStyle = "#5a6577";
  }
  const barW = 6;
  const gap = (w - BAR_COUNT * barW) / (BAR_COUNT - 1);
  for (let i = 0; i < BAR_COUNT; i++) {
    let level = 0;
    if (live) {
      let sum = 0;
      for (let j = 0; j < BINS_PER_BAR; j++) {
        sum += micFreqBuf![1 + i * BINS_PER_BAR + j] ?? 0; // skip the DC bin
      }
      level = Math.min(1, (sum / BINS_PER_BAR / 255) * 1.4);
    }
    const barH = 6 + level * (h - 6);
    const x = i * (barW + gap);
    waveCtx.beginPath();
    waveCtx.roundRect(x, (h - barH) / 2, barW, barH, 3);
    waveCtx.fill();
  }
}

let speakCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserBuf: Uint8Array<ArrayBuffer> | null = null;
let analysedStream: MediaStream | null = null;
let quietSince = 0;
let uiRaf = 0;

audio.addEventListener("playing", () => {
  const stream = audio.srcObject;
  if (!(stream instanceof MediaStream) || stream === analysedStream) return;
  void speakCtx?.close();
  speakCtx = new AudioContext();
  analyser = speakCtx.createAnalyser();
  analyser.fftSize = 512;
  speakCtx.createMediaStreamSource(stream).connect(analyser);
  analyserBuf = new Uint8Array(analyser.fftSize);
  analysedStream = stream;
});

function uiTick(now: number): void {
  drawMicWave();

  if (analyser && analyserBuf) {
    analyser.getByteTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i++) {
      const v = ((analyserBuf[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    if (Math.sqrt(sum / analyserBuf.length) > 0.03) {
      quietSince = 0;
      stage.dataset.speaking = "";
    } else {
      quietSince ||= now;
      // Half a second of hush before the glow drops — pauses between words
      // must not flicker it.
      if (now - quietSince > 500) delete stage.dataset.speaking;
    }
  }
  uiRaf = requestAnimationFrame(uiTick);
}

function stopLiveness(): void {
  cancelAnimationFrame(uiRaf);
  uiRaf = 0;
  micBtn.disabled = true;
  setMicMuted(false);
  micAnalyser = null;
  micFreqBuf = null;
  drawMicWave(); // leave idle stubs, not the last frame of speech
  delete stage.dataset.speaking;
  void speakCtx?.close();
  speakCtx = null;
  analyser = null;
  analyserBuf = null;
  analysedStream = null;
  quietSince = 0;
}

// The stage goes live on the first decoded frame, not on join — so the video
// fades in with a face already in it.
video.addEventListener("playing", () => {
  if (stage.dataset.state === "connecting") setStage("live");
});

// ── mic mute ──────────────────────────────────────────────────────────────────
// Muting disables the track (micCapture.setMuted) — silence keeps streaming,
// so the model still hears a continuous feed. The button reflects it via
// data-muted (red tint, flat bars, slashed icon).

let micMuted = false;

function setMicMuted(muted: boolean): void {
  micMuted = muted;
  mic?.setMuted(muted);
  if (muted) micBtn.dataset.muted = "";
  else delete micBtn.dataset.muted;
  micBtn.setAttribute("aria-pressed", String(muted));
  const label = muted ? "Unmute microphone" : "Mute microphone";
  micBtn.title = label;
  micBtn.setAttribute("aria-label", label);
}

micBtn.addEventListener("click", () => {
  if (mic) setMicMuted(!micMuted);
});

// ── session lifecycle ─────────────────────────────────────────────────────────

let sessionId: string | null = null;
let socket: SessionSocket | null = null;
let room: AvatarRoom | null = null;
let mic: MicCapture | null = null;
let generation = 0;
let stopping = false;

async function start(): Promise<void> {
  const myGeneration = ++generation;
  const superseded = () => generation !== myGeneration;

  startBtn.disabled = true;
  setStage("connecting");
  setStatus("starting session…", "busy");
  uiRaf ||= requestAnimationFrame(uiTick);

  let started: {
    session_id: string;
    livekit_url: string;
    livekit_client_token: string;
    ws_path: string;
    error?: string;
  };
  try {
    const response = await fetch("/api/session/start", { method: "POST" });
    started = (await response.json()) as typeof started;
    if (!response.ok) throw new Error(started.error ?? "could not start a session");
  } catch (err) {
    setStage("idle");
    setStatus(err instanceof Error ? err.message : "could not start a session", "error");
    startBtn.disabled = false;
    return;
  }

  // Cancelled while the mint was in flight: the session is real and billable,
  // so release it rather than letting the idle watchdog do it.
  if (superseded()) {
    void endOnServer(started.session_id);
    return;
  }
  sessionId = started.session_id;

  setStatus("connecting to the avatar…", "busy");
  try {
    room = await joinAvatarRoom(started.livekit_url, started.livekit_client_token, {
      video,
      audio,
    });
  } catch (err) {
    await stop(err instanceof Error ? err.message : "could not reach the avatar", "error");
    return;
  }
  if (superseded()) return;

  socket = openSessionSocket(started.ws_path, {
    onReady: () => {
      if (superseded()) return;
      setStatus("listening — just start talking", "live");
      stopBtn.disabled = false;
      void startMicCapture((base64) => socket?.sendMicAudio(base64))
        .then((capture) => {
          // getUserMedia takes real time; if the session ended in that window,
          // storing this would leave the mic light on with nothing to turn it
          // off.
          if (superseded()) {
            capture.stop();
            return;
          }
          mic = capture;
          micAnalyser = capture.analyser;
          micFreqBuf = new Uint8Array(capture.analyser.frequencyBinCount);
          micBtn.disabled = false;
        })
        .catch((err: unknown) => {
          setStatus(
            err instanceof Error ? `microphone unavailable: ${err.message}` : "microphone unavailable",
            "error",
          );
        });
    },
    onTurn: upsertTurn,
    onUi: overlays.render,
    onInterrupted: () => {
      // The rest of that sentence is never coming — reflect it rather than
      // leave a transcript that claims words nobody heard.
      lastAssistantLine?.classList.add("interrupted");
    },
    onError: (message) => setStatus(message, "error"),
    onClose: () => {
      if (!stopping) void stop("the session ended");
    },
  });
}

async function stop(reason?: string, kind: StatusKind = "idle"): Promise<void> {
  generation += 1; // cancel any in-flight start
  if (stopping) return;
  stopping = true;
  stopBtn.disabled = true;

  mic?.stop();
  mic = null;
  socket?.close();
  socket = null;
  await room?.disconnect();
  room = null;
  overlays.hideAll();
  stopLiveness();
  // The transcript lives exactly as long as the session: cleared here (its
  // #transcript:empty rule hides the container), not on start.
  transcriptEl.textContent = "";
  turnLines.clear();
  lastAssistantLine = null;

  const id = sessionId;
  sessionId = null;
  if (id) void endOnServer(id);

  setStage("idle");
  setStatus(reason ?? "idle", kind);
  startBtn.disabled = false;
  stopping = false;
}

async function endOnServer(id: string): Promise<void> {
  try {
    await fetch("/api/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id }),
    });
  } catch {
    // The server reaps the session on its own; nothing to recover here.
  }
}

// A tab closing mid-session would otherwise leave the session running (and
// billing) until the server's idle watchdog reaps it. Only sendBeacon survives
// unload; fetch is cancelled.
window.addEventListener("pagehide", () => {
  if (!sessionId) return;
  navigator.sendBeacon?.(
    "/api/session/stop",
    new Blob([JSON.stringify({ session_id: sessionId })], { type: "application/json" }),
  );
});

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => void stop());

drawMicWave(); // idle stubs before any session

// Dev hook: render a widget without burning session minutes —
//   window.__ui({ widget: "poker_table", props: { handNumber: 1, playerHand: ["As","Kd"],
//     board: ["Jh","8c","2s"], opponentHand: null, potBb: 6, playerStackBb: 97,
//     opponentStackBb: 97, toCallBb: 0, scoreBb: 0, statusText: "Your action", reveal: "flop" } })
(window as unknown as { __ui: typeof overlays.render }).__ui = overlays.render;
