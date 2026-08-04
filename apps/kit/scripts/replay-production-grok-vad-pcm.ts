import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  connectGrokRealtimeVoice,
  GROK_DEFAULT_INSTRUCTIONS,
  mintGrokRealtimeCredential,
} from "../src/userspace/config-worker/providers.ts";

const frameDurationMs = 20;
const trailingSilenceFrames = 100;
const completionGuardMs = 2_000;

export interface PcmReplayInterval {
  endSample?: number;
  startSample?: number;
}

/**
 * Replays the exact bytes accepted by the production provider socket.
 *
 * This is deliberately not an acoustic simulator. A retained
 * `accepted-uplink.pcm` file is the post-device-AEC, post-worker-gain byte
 * stream Grok actually received. Replaying it at wall-clock cadence isolates
 * provider VAD/transcription semantics from Wi-Fi, ESP scheduling, the room,
 * and speaker playback. That makes this the fast inner loop for a firmware AEC
 * change; the physical far-only and double-talk proof remains the outer gate.
 */
export async function replayProductionGrokVadPcm(
  pcmPath: string,
  apiKey: string,
  sampleRateHz = 16_000,
  instructions = GROK_DEFAULT_INSTRUCTIONS,
  interval: PcmReplayInterval = {},
): Promise<ReadonlyArray<Record<string, unknown>>> {
  if (sampleRateHz !== 16_000 && sampleRateHz !== 24_000) {
    throw new Error("The Grok diagnostic replay sample rate must be 16000 or 24000 Hz.");
  }
  const frameBytes = (sampleRateHz * frameDurationMs * Int16Array.BYTES_PER_ELEMENT) / 1_000;
  const retainedPcm = await readFile(pcmPath);
  if (retainedPcm.byteLength === 0 || retainedPcm.byteLength % frameBytes !== 0) {
    throw new Error(`PCM input must contain a non-zero whole number of ${frameBytes}-byte frames.`);
  }
  const pcm = selectPcmReplayInterval(retainedPcm, sampleRateHz, interval);

  const credential = await mintGrokRealtimeCredential({
    fetchCredential: async (request) => {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      return await fetch(new Request(request, { headers }));
    },
  });
  const socket = await connectGrokRealtimeVoice({
    credential,
    enableSpriteSetTool: false,
    /*
     * Provider semantics are part of this incident. The former diagnostic-only
     * prompt removed the production greeting and tool policy, so a replay could
     * disagree with the product even when every PCM byte and VAD setting was
     * identical. Default to the exact production policy; callers may still
     * supply an explicit A/B instruction without changing or resampling audio.
     */
    instructions,
    sampleRateHz,
    serverVadProfile: "low-level-aec",
    turnDetection: "server-vad",
  });
  const events: Record<string, unknown>[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const decoded: unknown = JSON.parse(event.data);
      if (isRecord(decoded)) events.push(decoded);
    } catch {
      events.push({ raw: event.data, type: "unparseable-provider-event" });
    }
  });

  try {
    let deadline = performance.now();
    for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
      socket.send(pcm.subarray(offset, offset + frameBytes));
      deadline += frameDurationMs;
      await delay(Math.max(0, deadline - performance.now()));
    }
    /*
     * A live device never stops its full-duplex lane after a phrase. Continue
     * its exact cadence with two seconds of digital silence so server VAD can
     * observe the configured one-second tail and close the turn. Merely
     * waiting without sending frames leaves the provider inside speech and
     * produces a misleading “no speech_stopped” result.
     */
    const silence = new Uint8Array(frameBytes);
    for (let frame = 0; frame < trailingSilenceFrames; frame += 1) {
      socket.send(silence);
      deadline += frameDurationMs;
      await delay(Math.max(0, deadline - performance.now()));
    }
    await delay(completionGuardMs);
    return events;
  } finally {
    socket.close(1000, "PCM VAD replay complete.");
  }
}

/**
 * Select an evidence phase without making a second, provenance-ambiguous PCM
 * file. Requiring exact production frame boundaries matters: rounding a phase
 * by even one sample changes both the bytes and wall-clock cadence presented
 * to server VAD, defeating the purpose of a byte-for-byte provider replay.
 */
export function selectPcmReplayInterval(
  pcm: Uint8Array,
  sampleRateHz: number,
  interval: PcmReplayInterval,
): Uint8Array {
  const frameSamples = (sampleRateHz * frameDurationMs) / 1_000;
  if (!Number.isSafeInteger(frameSamples)) {
    throw new Error("The replay sample rate must form exact 20 ms PCM frames.");
  }
  const availableSamples = pcm.byteLength / Int16Array.BYTES_PER_ELEMENT;
  const startSample = interval.startSample ?? 0;
  const endSample = interval.endSample ?? availableSamples;
  if (
    !Number.isSafeInteger(startSample) ||
    !Number.isSafeInteger(endSample) ||
    startSample < 0 ||
    startSample >= endSample ||
    endSample > availableSamples
  ) {
    throw new Error(
      `The requested replay interval [${startSample}, ${endSample}) is outside ` +
        `${availableSamples} available samples.`,
    );
  }
  if (startSample % frameSamples !== 0 || endSample % frameSamples !== 0) {
    throw new Error("Replay intervals must begin and end on 20 ms PCM frame boundaries.");
  }
  return pcm.subarray(
    startSample * Int16Array.BYTES_PER_ELEMENT,
    endSample * Int16Array.BYTES_PER_ELEMENT,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pcmPath = process.argv[2];
  if (!pcmPath) {
    throw new Error("Usage: replay-production-grok-vad-pcm.ts <accepted-uplink.pcm>");
  }
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required.");
  /*
   * xAI documents both 16 and 24 kHz PCM input, but its voice model may not
   * behave identically at those rates. The optional rate makes the retained
   * byte-for-byte replay a provider-adapter A/B; it never silently resamples
   * the physical capture or changes the production device contract.
   */
  const sampleRateHz = process.argv[3] === undefined ? 16_000 : Number(process.argv[3]);
  const startSample = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
  const endSample = process.argv[5] === undefined ? undefined : Number(process.argv[5]);
  const events = await replayProductionGrokVadPcm(
    pcmPath,
    apiKey,
    sampleRateHz,
    GROK_DEFAULT_INSTRUCTIONS,
    { endSample, startSample },
  );
  const semanticEvents = events.filter((event) => {
    const type = typeof event.type === "string" ? event.type : "";
    return (
      type.includes("speech_") ||
      type.includes("transcription") ||
      type === "response.created" ||
      type === "response.done" ||
      type === "error"
    );
  });
  console.log(JSON.stringify({ eventCount: events.length, semanticEvents }, null, 2));
}
