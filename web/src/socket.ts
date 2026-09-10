/**
 * The browser's leg of the session websocket. Mic audio goes up; transcripts
 * and visuals come down. Avatar audio/video do NOT travel here — they arrive
 * over LiveKit, because the server threads audio into the media server itself.
 */
import type { ClientMessage, ServerMessage, Turn, UiMessage } from "../../shared/messages";

export interface SessionSocketHandlers {
  onReady: () => void;
  onTurn: (turn: Turn) => void;
  onUi: (msg: UiMessage) => void;
  /** The avatar was cut off: what it was mid-way through saying is gone. */
  onInterrupted: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface SessionSocket {
  sendMicAudio: (base64: string) => void;
  close: () => void;
}

export function openSessionSocket(
  wsPath: string,
  handlers: SessionSocketHandlers,
): SessionSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
  let closedByUs = false;

  ws.onmessage = (event: MessageEvent<string>) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        handlers.onReady();
        break;
      case "turn":
        handlers.onTurn(msg);
        break;
      case "ui":
        handlers.onUi(msg);
        break;
      case "interrupted":
        handlers.onInterrupted();
        break;
      case "error":
        handlers.onError(msg.message);
        break;
    }
  };

  ws.onerror = () => handlers.onError("lost connection to the server");
  ws.onclose = () => {
    // A close we initiated is the normal end of a session, not a failure.
    if (!closedByUs) handlers.onClose();
  };

  const send = (payload: ClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  return {
    sendMicAudio: (audio) => send({ type: "mic_audio", audio }),
    close: () => {
      closedByUs = true;
      send({ type: "stop" });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}
