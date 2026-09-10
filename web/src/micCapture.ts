/**
 * Microphone → base64 PCM16 mono @ 24kHz, via an AudioWorklet.
 *
 * Deliberately NO voice-activity detection: GPT-Live is full-duplex and
 * decides turn-taking itself, hearing the same audio with the conversation as
 * context. The browser only does I/O. Downsampling happens on the audio thread
 * because doing it on the main thread drops frames whenever the page renders.
 */

const TARGET_SAMPLE_RATE = 24000;

const WORKLET_CODE = `
class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 24000;
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const out = [];
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const start = Math.floor(this.pos);
      const end = Math.min(ch.length, Math.ceil(this.pos + this.ratio));
      let sum = 0, cnt = 0;
      for (let j = start; j < end; j++) { sum += ch[j]; cnt++; }
      out.push(cnt ? sum / cnt : (ch[start] || 0));
    }
    this.pos -= ch.length;
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) {
      let s = Math.max(-1, Math.min(1, out[k]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm-downsampler', PCMDownsampler);
`;

export interface MicCapture {
  stop: () => void;
  /**
   * Mute by disabling the track, not by pausing capture: a disabled track
   * renders silence, so the worklet keeps shipping frames and the model hears
   * a continuous (silent) stream — turn detection stays with the model.
   */
  setMuted: (muted: boolean) => void;
  /**
   * Taps the same mic source the worklet consumes — for UI (the frequency
   * bars on the mic button). Muting flattens it automatically: a disabled
   * track renders silence into the analyser too.
   */
  analyser: AnalyserNode;
}

export async function startMicCapture(
  onAudio: (base64Pcm24k: string) => void,
  onLevel?: (rms01: number) => void,
): Promise<MicCapture> {
  // Echo cancellation matters more than usual here: the avatar's own voice
  // plays out of the same machine the mic is listening on, and without it the
  // model hears itself and answers itself.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const audioContext = new AudioContext();
  // Chrome starts a context suspended unless it was created inside a user
  // gesture. This one is created after `await getUserMedia`, which has already
  // left the gesture's call stack — without the resume the worklet is never
  // pumped: no frames, no error, an avatar that simply cannot hear you.
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-downsampler", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: TARGET_SAMPLE_RATE },
  });

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const bytes = new Uint8Array(e.data);
    if (bytes.length === 0) return;
    if (onLevel) {
      // Level is a UI courtesy (the mic meter), computed off the same chunk
      // that ships — what the meter shows is exactly what the model hears.
      const samples = new Int16Array(e.data);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i] ?? 0;
        sum += s * s;
      }
      onLevel(Math.sqrt(sum / samples.length) / 0x8000);
    }
    onAudio(base64FromBytes(bytes));
  };

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  source.connect(worklet);
  // A worklet only runs while connected to the destination, but its output is
  // the raw mic — routing it through a muted gain keeps it pumping without
  // playing the user back to themselves.
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  worklet.connect(mute);
  mute.connect(audioContext.destination);

  return {
    analyser,
    setMuted: (muted) => {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    stop: () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      mute.disconnect();
      analyser.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();
    },
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
