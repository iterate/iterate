import { ITERATE_KIT_PCM_FRAME_BYTES, ITERATE_KIT_PCM_SAMPLE_RATE_HZ } from "./pcm-proxy.ts";

const XAI_CLIENT_SECRET_PATH = "/secrets/kit/xai-api-key";
const XAI_CLIENT_SECRET_LIFETIME_SECONDS = 60 * 60;
const supportedPcmSampleRates = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]);
/*
 * The M5StickS3 direct-I2S implementation intentionally keeps the ES8311 at
 * -18 dB. That is the measured hardware safety ceiling: driving the codec at
 * 0 dB browned out the board, while a 75%-scale PCM source through this
 * setting was both safe and audible in the direct-LAN physical harness.
 *
 * Do not "make the fixture gentle" with another arbitrary software gain.
 * Doing so compounds the codec attenuation and can produce a run whose DMA
 * counters are perfect but whose sound is not physically observable. Keeping
 * the source level here equal to the proven fixture also makes production and
 * local acoustic evidence comparable.
 */
const deterministicTonePeakSample = 24_576;

export interface AcceptedSocketPair {
  first: WebSocket;
  second: WebSocket;
}

export interface DeterministicToneOptions {
  createPair?: () => AcceptedSocketPair;
  durationMs: number;
  frequencyHz: number;
  sampleRateHz: number;
}

export interface GrokRealtimeVoiceOptions {
  connectTimeoutMs?: number;
  createWebSocket?: (url: string, protocols: readonly string[]) => WebSocket;
  fetchCredential(request: Request): Promise<Response>;
  instructions?: string;
  model?: string;
  sampleRateHz: number;
  voice?: string;
}

/**
 * Deterministic return audio is a provider at the same seam as Grok, not a
 * firmware shortcut. A physical proof therefore still traverses the deployed
 * app host, userspace PCM core, public network, ESP WebSocket receiver, and
 * speaker owner. Only provider variability is removed.
 */
export async function connectDeterministicTone(
  options: DeterministicToneOptions,
): Promise<WebSocket> {
  if (
    !Number.isSafeInteger(options.durationMs) ||
    options.durationMs <= 0 ||
    options.durationMs > 10 * 60 * 1_000
  ) {
    throw new Error("The deterministic tone duration must be from 1 ms through 10 minutes.");
  }
  if (
    !Number.isFinite(options.frequencyHz) ||
    options.frequencyHz <= 0 ||
    options.frequencyHz >= options.sampleRateHz / 2
  ) {
    throw new Error("The deterministic tone frequency must be below Nyquist.");
  }
  if (
    !Number.isSafeInteger(options.sampleRateHz) ||
    options.sampleRateHz <= 0 ||
    (options.sampleRateHz * 20) % 1_000 !== 0
  ) {
    throw new Error("The deterministic tone requires a whole number of samples per 20 ms frame.");
  }

  const pair = (options.createPair ?? nativeSocketPair)();
  /*
   * Neither half leaves this worker in a 101 Response. Workerd therefore has
   * no response hand-off that implicitly owns the "client" half: both local
   * endpoints must be accepted before the bridge can send response.create or
   * the renderer can emit PCM. Accepting only the renderer looks plausible in
   * unit fakes but fails the first real production send.
   */
  pair.first.accept();
  pair.second.accept();
  const provider = pair.first;
  const renderer = createToneRenderer(options.frequencyHz, options.sampleRateHz);
  let stream: AbortController | undefined;
  pair.second.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const control = providerControl(event.data);
    if (control === "input_audio_buffer.commit") {
      /*
       * Tone mode substitutes only deterministic output generation. It must
       * still behave like the manual-turn provider that production exercises:
       * a release commits the live microphone buffer, the provider confirms
       * ownership of that turn, and only then may the bridge request speech.
       * A mock that skipped this acknowledgement made connection-time tones
       * look healthy while every real PTT release deadlocked at the control
       * fence.
       */
      pair.second.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
      return;
    }
    if (control === "response.cancel") {
      stream?.abort();
      stream = undefined;
      return;
    }
    if (control !== "response.create" || stream) return;
    stream = new AbortController();
    const current = stream;
    void streamTone(pair.second, renderer, options, current.signal).finally(() => {
      if (stream === current) stream = undefined;
    });
  });
  return provider;
}

/**
 * Opens one xAI Voice 2.0 socket with raw PCM at the device's native rate.
 * The long-lived key appears only as an Iterate egress placeholder on the
 * HTTPS credential mint; the WebSocket receives the resulting short-lived
 * secret.
 */
export async function connectGrokRealtimeVoice(
  options: GrokRealtimeVoiceOptions,
): Promise<WebSocket> {
  if (!supportedPcmSampleRates.has(options.sampleRateHz)) {
    throw new Error(`Grok does not support ${options.sampleRateHz} Hz PCM audio.`);
  }
  const credentialResponse = await options.fetchCredential(
    new Request("https://api.x.ai/v1/realtime/client_secrets", {
      /*
       * This expiry controls how long the minted credential may authorize the
       * realtime connection; it is not a WebSocket keepalive guarantee. The
       * upstream may still retire an idle socket much sooner, which is why the
       * bridge treats provider generations as replaceable without taking down
       * the device's long-lived `/pcm` lane.
       */
      body: JSON.stringify({
        expires_after: { seconds: XAI_CLIENT_SECRET_LIFETIME_SECONDS },
      }),
      headers: {
        authorization: `Bearer getSecret("${XAI_CLIENT_SECRET_PATH}")`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  if (!credentialResponse.ok) {
    throw new Error(
      `Grok client credential request failed with status ${credentialResponse.status}.`,
    );
  }
  const credential: unknown = await credentialResponse.json();
  if (!isGrokClientCredential(credential)) {
    throw new Error("Grok returned a malformed client credential.");
  }

  const endpoint = new URL("wss://api.x.ai/v1/realtime");
  endpoint.searchParams.set("model", options.model ?? "grok-voice-think-fast-2.0");
  const createWebSocket =
    options.createWebSocket ??
    ((url: string, protocols: readonly string[]) => new WebSocket(url, [...protocols]));
  const socket = createWebSocket(endpoint.href, [`xai-client-secret.${credential.value}`]);
  socket.binaryType = "arraybuffer";
  try {
    await waitForOpen(socket, options.connectTimeoutMs ?? 10_000);
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { rate: options.sampleRateHz, type: "audio/pcm" },
              transcription: { model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: { rate: options.sampleRateHz, type: "audio/pcm" },
              transport: "binary",
            },
          },
          instructions: options.instructions ?? "Be concise, conversational, and useful.",
          /*
           * Button B owns the lifetime of one conversation. Grok must retain
           * preceding PTT turns for that lifetime; otherwise repeated Button A
           * presses share a socket but behave like unrelated voice requests.
           */
          keep_context: true,
          /*
           * This userspace app serves a physical PTT device. Keeping manual
           * turn detection unconditional makes it impossible for a future
           * caller to silently re-enable server VAD without also redesigning
           * the two-button firmware contract and its interruption evidence.
           */
          tools: [
            {
              description: "Change the physical M5StickS3 display background to red or green.",
              name: "changeColour",
              parameters: {
                additionalProperties: false,
                properties: {
                  colour: { enum: ["red", "green"], type: "string" },
                },
                required: ["colour"],
                type: "object",
              },
              type: "function",
            },
          ],
          turn_detection: { type: null },
          voice: options.voice ?? "eve",
        },
      }),
    );
    return socket;
  } catch (error) {
    socket.close(1000, "Grok connection setup failed.");
    throw error;
  }
}

function nativeSocketPair(): AcceptedSocketPair {
  const pair = new WebSocketPair();
  const first = pair[0];
  const second = pair[1];
  return { first, second };
}

function createToneRenderer(frequencyHz: number, sampleRateHz: number) {
  let sampleOffset = 0;
  const radiansPerSample = (2 * Math.PI * frequencyHz) / sampleRateHz;
  return (sampleCount: number) => {
    const pcm = new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = Math.round(
        Math.sin((sampleOffset + index) * radiansPerSample) * deterministicTonePeakSample,
      );
      view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, sample, true);
    }
    sampleOffset += sampleCount;
    return pcm;
  };
}

async function streamTone(
  socket: WebSocket,
  render: (sampleCount: number) => Uint8Array,
  options: DeterministicToneOptions,
  signal: AbortSignal,
) {
  socket.send(JSON.stringify({ type: "response.created" }));
  const samplesPerFrame = (options.sampleRateHz * 20) / 1_000;
  const totalSamples = Math.ceil((options.sampleRateHz * options.durationMs) / 1_000);
  let emittedSamples = 0;
  let deadline = performance.now();
  while (emittedSamples < totalSamples) {
    if (signal.aborted) return;
    /*
     * The device contract is fixed at 640-byte frames for 16 kHz. The worker
     * currently selects this fixture only for that same format; fail loudly if
     * a future mode changes rates without first versioning the device lane.
     */
    const frame = render(samplesPerFrame);
    if (frame.byteLength !== ITERATE_KIT_PCM_FRAME_BYTES) {
      throw new Error("The deterministic provider rate does not match the PCM v1 frame.");
    }
    socket.send(frame);
    emittedSamples += samplesPerFrame;
    if (emittedSamples >= totalSamples) break;
    deadline += 20;
    await waitUntil(deadline, signal);
  }
  if (!signal.aborted) socket.send(JSON.stringify({ type: "response.done" }));
}

function waitUntil(deadline: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, Math.max(0, deadline - performance.now()));
    function finish() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      resolve();
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function providerControl(text: string): string | null {
  try {
    const decoded: unknown = JSON.parse(text);
    return isProviderControl(decoded) ? decoded.type : null;
  } catch {
    return null;
  }
}

function isProviderControl(value: unknown): value is { type: string } {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function isGrokClientCredential(value: unknown): value is { expires_at: number; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "expires_at" in value &&
    typeof value.expires_at === "number" &&
    Number.isFinite(value.expires_at) &&
    "value" in value &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    value.value.length <= 512
  );
}

function waitForOpen(socket: WebSocket, timeoutMs: number) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Grok WebSocket handshake timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const opened = () => {
      cleanup();
      resolve();
    };
    const errored = () => {
      cleanup();
      reject(new Error("Grok WebSocket handshake failed."));
    };
    const closed = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`Grok WebSocket closed during handshake with code ${event.code}.`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", errored);
      socket.removeEventListener("close", closed);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", errored, { once: true });
    socket.addEventListener("close", closed, { once: true });
  });
}

/*
 * Keep this assertion near the deterministic provider: PCM v1 intentionally
 * avoids server/device resampling, so the shared frame constant and the chosen
 * native rate must remain the same contract.
 */
if (
  (ITERATE_KIT_PCM_SAMPLE_RATE_HZ * 20 * Int16Array.BYTES_PER_ELEMENT) / 1_000 !==
  ITERATE_KIT_PCM_FRAME_BYTES
) {
  throw new Error("PCM v1 constants do not describe one 20 ms PCM16 frame.");
}
