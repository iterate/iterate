import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const pcm16BytesPerSample = 2;
const sttChunkDurationMs = 100;

export interface XaiStreamingSttSocket extends EventTarget {
  close(): void;
  send(value: string | Uint8Array): void;
}

interface XaiStreamingSttOptions {
  apiKey: string;
  createSocket?: (url: URL, headers: Readonly<Record<string, string>>) => XaiStreamingSttSocket;
  pcm: Uint8Array;
  sampleRateHz: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface XaiStreamingSttResult {
  durationSeconds: number;
  rawEvents: string[];
  text: string;
  words: unknown[];
}

/**
 * Transcribes a raw mono PCM16LE artifact through xAI's standalone STT lane.
 *
 * This is intentionally separate from the conversational provider socket. In
 * the physical harness it receives only the nearby Mac microphone recording,
 * so matching its result to Grok's output transcript proves the sentence
 * crossed the device DAC, amplifier, air gap, and Mac ADC. It cannot simply
 * echo provider metadata or be satisfied by frame-accounting counters.
 *
 * VAD gating is disabled because the Stick's codec is deliberately capped at
 * its measured -18 dB brownout-safe ceiling. The oracle is asked to recognise
 * whatever the microphone captured; the caller separately retains absolute
 * energy, noise-floor, clipping, and network evidence instead of hiding a
 * quiet physical result behind the transcription.
 */
export async function transcribePcm16WithXaiStreamingStt(
  options: XaiStreamingSttOptions,
): Promise<XaiStreamingSttResult> {
  if (!options.apiKey.trim()) throw new Error("An xAI API key is required for acoustic STT.");
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error("The acoustic STT sample rate must be a positive integer.");
  }
  if (options.pcm.byteLength % pcm16BytesPerSample !== 0) {
    throw new Error("The acoustic STT PCM16 artifact must contain complete samples.");
  }

  const endpoint = new URL("wss://api.x.ai/v1/stt");
  endpoint.searchParams.set("encoding", "pcm");
  endpoint.searchParams.set("endpointing", "0");
  endpoint.searchParams.set("interim_results", "false");
  endpoint.searchParams.set("sample_rate", String(options.sampleRateHz));
  endpoint.searchParams.set("vad_threshold", "0");
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const createSocket =
    options.createSocket ??
    ((url: URL, requestHeaders: Readonly<Record<string, string>>) =>
      new WebSocket(url, { headers: requestHeaders }) as unknown as XaiStreamingSttSocket);
  const socket = createSocket(endpoint, headers);
  const sleep = options.sleep ?? (async (milliseconds) => await delay(milliseconds));
  const rawEvents: string[] = [];

  return await new Promise<XaiStreamingSttResult>((resolve, reject) => {
    let settled = false;
    let sending = false;
    let speechFinalText = "";
    let speechFinalWords: unknown[] = [];
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for xAI acoustic STT."));
    }, options.timeoutMs ?? 30_000);

    const finish = (result: XaiStreamingSttResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      try {
        socket.close();
      } catch {
        // The transcript/error is already authoritative; close is best-effort cleanup.
      }
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const sendAudio = async () => {
      if (sending) return;
      sending = true;
      const chunkBytes = (options.sampleRateHz * pcm16BytesPerSample * sttChunkDurationMs) / 1_000;
      if (!Number.isSafeInteger(chunkBytes)) {
        finish(new Error("The acoustic STT sample rate does not form exact 100 ms PCM chunks."));
        return;
      }
      try {
        for (let offset = 0; offset < options.pcm.byteLength; offset += chunkBytes) {
          const end = Math.min(options.pcm.byteLength, offset + chunkBytes);
          socket.send(options.pcm.subarray(offset, end));
          if (end < options.pcm.byteLength) await sleep(sttChunkDurationMs);
        }
        socket.send(JSON.stringify({ type: "audio.done" }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onMessage = (event: Event) => {
      try {
        const raw = messageText((event as MessageEvent).data);
        rawEvents.push(raw);
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || typeof value.type !== "string") return;
        if (value.type === "transcript.created") {
          void sendAudio();
          return;
        }
        if (value.type === "error") {
          finish(new Error(`xAI acoustic STT failed: ${raw}`));
          return;
        }
        if (
          value.type === "transcript.partial" &&
          value.speech_final === true &&
          typeof value.text === "string" &&
          value.text.trim()
        ) {
          speechFinalText = value.text;
          speechFinalWords = Array.isArray(value.words) ? value.words : [];
          return;
        }
        if (value.type === "transcript.done") {
          const doneText = typeof value.text === "string" ? value.text.trim() : "";
          finish({
            durationSeconds: typeof value.duration === "number" ? value.duration : 0,
            rawEvents,
            text: doneText || speechFinalText,
            words: doneText && Array.isArray(value.words) ? value.words : speechFinalWords,
          });
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = () => finish(new Error("The xAI acoustic STT WebSocket failed."));

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("xAI acoustic STT returned a non-text control event.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
