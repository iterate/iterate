// The browser's audio, kept to what the relay speaks: 16 kHz mono PCM16, base64 on the wire, 50 ms
// microphone frames in, answer frames of any length out. One AudioContext at 16 kHz carries both
// directions, so no resampling happens here; the two worklets (public/worklets) do the per-sample
// work off the main thread.

/** 16 kHz, one 50 ms frame = 800 samples. */
export const FRAME_SAMPLES = 800;

/** PCM16 samples to the base64 the relay's `mic-frame` carries. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A `spk-frame`'s base64 back to PCM16 samples (a fresh, aligned buffer). */
export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export type AudioSession = {
  /** Set by the call: receives one 800-sample frame every 50 ms while the microphone is open. */
  onFrame: ((pcm: Int16Array) => void) | null;
  /** Queue an answer chunk for the speaker; `clear` drops whatever is queued. */
  speaker: { push(pcm: Int16Array): void; clear(): void };
  close(): Promise<void>;
};

/** Open the microphone and the speaker on one 16 kHz context. Must run from a user gesture. */
export async function openAudio(): Promise<AudioSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16_000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: 16_000 });
  await Promise.all([
    context.audioWorklet.addModule("/worklets/capture.js"),
    context.audioWorklet.addModule("/worklets/playback.js"),
  ]);
  const capture = new AudioWorkletNode(context, "capture");
  const playback = new AudioWorkletNode(context, "playback");
  context.createMediaStreamSource(stream).connect(capture);
  capture.connect(context.destination); // silent output; connected so the worklet keeps running
  playback.connect(context.destination);
  const session: AudioSession = {
    onFrame: null,
    speaker: {
      push: (pcm) => playback.port.postMessage({ type: "push", pcm }, [pcm.buffer]),
      clear: () => playback.port.postMessage({ type: "clear" }),
    },
    close: async () => {
      capture.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    },
  };
  capture.port.onmessage = (event: MessageEvent<Int16Array>) => session.onFrame?.(event.data);
  await context.resume();
  return session;
}
