const pcm16BytesPerSample = 2;
const maximumErrorBodyCharacters = 4_096;
const defaultBatchTimeoutMs = 120_000;

export interface XaiBatchSttResult {
  durationSeconds: number;
  rawEvents: string[];
  text: string;
  words: unknown[];
}

interface XaiBatchSttOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  pcm: Uint8Array;
  sampleRateHz: number;
  timeoutMs?: number;
}

export interface OverlappingPcm16Window {
  endSample: number;
  pcm: Uint8Array;
  startSample: number;
}

/**
 * Produces zero-copy, sample-aligned windows that cover an entire PCM16 file.
 *
 * A regular hop leaves a short tail whenever the response length is not an
 * exact multiple. That tail is precisely where a clipped final spoken number
 * would occur, so the last window is anchored to the physical end boundary.
 * Returning views avoids multiplying memory use for a long retained capture;
 * the upload function makes its own request-owned copy immediately before
 * handing bytes to fetch.
 */
export function sliceOverlappingPcm16Windows(input: {
  hopSamples: number;
  pcm: Uint8Array;
  windowSamples: number;
}): OverlappingPcm16Window[] {
  if (input.pcm.byteLength % pcm16BytesPerSample !== 0) {
    throw new Error("Overlapping PCM16 windows require complete samples.");
  }
  if (
    !Number.isSafeInteger(input.windowSamples) ||
    !Number.isSafeInteger(input.hopSamples) ||
    input.windowSamples <= 0 ||
    input.hopSamples <= 0 ||
    input.hopSamples >= input.windowSamples
  ) {
    throw new Error("PCM16 window and hop sizes must be positive, overlapping integers.");
  }

  const totalSamples = input.pcm.byteLength / pcm16BytesPerSample;
  if (totalSamples === 0) return [];
  const actualWindowSamples = Math.min(input.windowSamples, totalSamples);
  const finalStartSample = totalSamples - actualWindowSamples;
  const starts: number[] = [];
  for (let start = 0; start < finalStartSample; start += input.hopSamples) {
    starts.push(start);
  }
  if (starts.at(-1) !== finalStartSample) starts.push(finalStartSample);
  return starts.map((startSample) => {
    const endSample = startSample + actualWindowSamples;
    return {
      endSample,
      pcm: input.pcm.subarray(startSample * pcm16BytesPerSample, endSample * pcm16BytesPerSample),
      startSample,
    };
  });
}

/**
 * Transcribes one completed raw PCM16LE artifact with xAI's file API.
 *
 * Production audio remains on the low-latency WebSocket. This function serves
 * a different purpose: judging a Mac-microphone file after the physical run is
 * over. Replaying that file through streaming STT introduced artificial
 * `speech_final` boundaries; a single number could be represented once at the
 * end of one utterance and again at the beginning of the next. Removing those
 * duplicates heuristically could also hide a real speaker repeat. The batch
 * endpoint lets the speech model own one complete-file transcript and deletes
 * that unsafe segment-assembly policy from the acceptance path.
 */
export async function transcribePcm16WithXaiBatchStt(
  options: XaiBatchSttOptions,
): Promise<XaiBatchSttResult> {
  if (!options.apiKey.trim()) throw new Error("An xAI API key is required for acoustic STT.");
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error("The acoustic STT sample rate must be a positive integer.");
  }
  if (options.pcm.byteLength % pcm16BytesPerSample !== 0) {
    throw new Error("The acoustic STT PCM16 artifact must contain complete samples.");
  }
  const timeoutMs = options.timeoutMs ?? defaultBatchTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The acoustic STT timeout must be a positive integer.");
  }

  const form = new FormData();
  form.append("audio_format", "pcm");
  form.append("sample_rate", String(options.sampleRateHz));
  form.append("vad_threshold", "0");
  /*
   * xAI documents that `file` must be the last multipart field because later
   * fields can be ignored by its streaming multipart parser. In particular,
   * losing `sample_rate` would time-warp the physical evidence silently.
   */
  const pcmCopy = new ArrayBuffer(options.pcm.byteLength);
  new Uint8Array(pcmCopy).set(options.pcm);
  form.append(
    "file",
    new Blob([pcmCopy], { type: "application/octet-stream" }),
    "microphone.pcm16le",
  );

  const request = options.fetch ?? globalThis.fetch;
  const response = await request("https://api.x.ai/v1/stt", {
    body: form,
    headers: { authorization: `Bearer ${options.apiKey}` },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `xAI batch acoustic STT failed with HTTP ${response.status}: ` +
        raw.slice(0, maximumErrorBodyCharacters),
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("xAI batch acoustic STT returned invalid JSON.");
  }
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    value.duration < 0 ||
    (value.words !== undefined && !Array.isArray(value.words))
  ) {
    throw new Error("xAI batch acoustic STT did not return valid transcript text and words.");
  }

  return {
    durationSeconds: value.duration,
    rawEvents: [raw],
    text: value.text.trim(),
    words: value.words ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
