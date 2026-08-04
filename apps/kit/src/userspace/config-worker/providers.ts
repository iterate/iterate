import { ITERATE_KIT_PCM_FRAME_BYTES, ITERATE_KIT_PCM_SAMPLE_RATE_HZ } from "./pcm-proxy.ts";
import { KIT_SPRITE_SETS } from "./sprite-sets.ts";
import {
  createDeterministicAecRenderer,
  DETERMINISTIC_AEC_DURATION_MS,
  DETERMINISTIC_AEC_SAMPLE_RATE_HZ,
  type DeterministicAecPcmRenderer,
} from "./deterministic-aec-fixture.ts";

const XAI_API_KEY_SECRET_PATH = "/secrets/kit/xai-api-key";
const XAI_CLIENT_SECRET_LIFETIME_SECONDS = 60 * 60;
/**
 * Product policy for the audio model's ambiguous short-turn boundary.
 *
 * The exact production PCM for a physical “Hey pal” turn is independently
 * transcribed correctly by xAI's dedicated transcription endpoint, while the
 * realtime model has stochastically revised the same short audio to “Hey now”,
 * “PayPal”, and “Play now”. The last variant caused Grok to infer a sprite
 * operation merely because that tool was present. Firmware filtering cannot
 * repair provider-side semantic revision without also risking near speech, so
 * this policy keeps ambiguous openers conversational and makes the optional
 * device tool opt-in by explicit vocabulary.
 *
 * Do not force a canned first reply. A production count proof delivered the
 * complete concrete instruction “start with one, end with one hundred”, yet
 * Grok returned the old mandated greeting instead of performing it. Adding a
 * synthetic warm-up turn would hide the defect and make ordinary first-turn
 * latency worse. Silence before actual speech belongs to transport policy;
 * after speech, the model must answer the complete request it received.
 */
export const GROK_DEFAULT_INSTRUCTIONS =
  "Be concise, conversational, useful, and pleasantly decisive. Wait silently until the user speaks. Respond to the user's complete request, including the first turn; never replace a concrete request with a generic greeting. Prefer taking a safe, reversible action over asking a follow-up question or requesting permission. Use good judgment, make reasonable choices, and occasionally surprise the user in a delightful way; ask a question only when a missing answer materially changes the outcome or safety. If a short opening is ambiguous, treat it as a greeting and ask how you can help. Never infer a face, avatar, sprite, gesture, or hang-up from unrelated words. When the user explicitly asks to change the face, avatar, or sprite without naming one, choose an appropriate supported sprite set yourself and call changeSpriteSet instead of asking which one. On StackChan, accompany a clearly affirmative or agreeing spoken answer with the nod tool, and accompany a clearly negative, disagreeing, or refusing spoken answer with the shakeHead tool; do both naturally without announcing the gesture. For example, if the user asks “Are you there?”, call nod and say “Yes, I’m here.” Do not gesture for quoted, hypothetical, or ambiguous yes/no language. Also obey an explicit gesture request. If the user says stop, pause, be quiet, or otherwise interrupts while you are speaking, stop that reply and remain in the conversation; do not call endConversation. Call endConversation only when the user explicitly asks to end the conversation, hang up, or go back to sleep; treat “go back to sleep” as an explicit hang-up, optionally give a brief sign-off, call endConversation, and do not ask for confirmation. Do not list tools or sprite sets unless the user asks. Do not claim a physical action succeeded until its tool result says it did.";
const GROK_CREDENTIAL_MINIMUM_REMAINING_MS = 5_000;
const GROK_CREDENTIAL_REFRESH_LEAD_MS = 60_000;
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

export interface DeterministicAecOptions {
  createPair?: () => AcceptedSocketPair;
}

export type GrokServerVadProfile = "low-level-aec" | "xmos-aec";

export interface GrokRealtimeVoiceOptions {
  connectTimeoutMs?: number;
  createWebSocket?: (url: string, protocols: readonly string[]) => WebSocket;
  credential: GrokRealtimeCredential;
  deviceId?: string;
  enableSpriteSetTool?: boolean;
  instructions?: string;
  model?: string;
  onStage?: (stage: GrokRealtimeVoiceStage) => void;
  sampleRateHz: number;
  serverVadProfile?: GrokServerVadProfile;
  turnDetection: "manual" | "server-vad";
  voice?: string;
}

export interface GrokRealtimeVoiceStage {
  atMs: number;
  code:
    | "credential-prewarm-started"
    | "credential-prewarm-received"
    | "credential-prewarm-decoded"
    | "provider-websocket-created"
    | "provider-websocket-opened"
    | "session-update-sent";
}

export interface GrokRealtimeCredential {
  expiresAtEpochSeconds: number;
  value: string;
}

export interface GrokRealtimeCredentialOptions {
  fetchCredential(request: Request): Promise<Response>;
  onStage?: (stage: GrokRealtimeVoiceStage) => void;
}

export interface GrokCredentialPrewarmerMetrics {
  attempts: number;
  expiresAtEpochSeconds: number | null;
  failures: number;
  lastError: string | null;
  state: "disposed" | "empty" | "ready" | "warming";
}

export interface GrokCredentialPrewarmerOptions {
  mintCredential(): Promise<GrokRealtimeCredential>;
  now?: () => number;
  onFailure?: (error: unknown) => void;
  runInBackground?: (promise: Promise<void>) => void;
}

/**
 * Holds exactly one unused xAI credential ahead of the physical call edge.
 *
 * This is deliberately not a normal TTL cache. A production probe proved
 * that xAI accepts an ephemeral credential for one WebSocket and returns 401
 * on its second use. `take()` therefore removes the credential atomically and
 * begins minting its successor immediately, in parallel with the current
 * provider handshake and conversation. A bounded expiry timer refreshes a
 * credential that sits unused while the Stick is idle.
 */
export class GrokCredentialPrewarmer {
  readonly #now: () => number;
  readonly #options: GrokCredentialPrewarmerOptions;
  #attempts = 0;
  #available: GrokRealtimeCredential | undefined;
  #disposed = false;
  #failures = 0;
  #inFlight: Promise<GrokRealtimeCredential> | undefined;
  #lastError: string | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GrokCredentialPrewarmerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async prewarm(): Promise<void> {
    await this.#startMint();
  }

  async take(): Promise<GrokRealtimeCredential> {
    for (;;) {
      if (this.#disposed) throw new Error("The Grok credential prewarmer is disposed.");
      const available = this.#available;
      if (available !== undefined) {
        const remainingMs = available.expiresAtEpochSeconds * 1_000 - this.#now();
        this.#available = undefined;
        this.#clearRefreshTimer();
        if (remainingMs > GROK_CREDENTIAL_MINIMUM_REMAINING_MS) {
          /*
           * Refill now, rather than at hangup. Credential egress can overlap
           * the provider WebSocket and the whole current conversation, so the
           * next call does not inherit this call's authentication latency.
           */
          void this.#startMint();
          return available;
        }
      }
      await this.#startMint();
    }
  }

  metrics(): GrokCredentialPrewarmerMetrics {
    return {
      attempts: this.#attempts,
      expiresAtEpochSeconds: this.#available?.expiresAtEpochSeconds ?? null,
      failures: this.#failures,
      lastError: this.#lastError,
      state: this.#disposed
        ? "disposed"
        : this.#available !== undefined
          ? "ready"
          : this.#inFlight !== undefined
            ? "warming"
            : "empty",
    };
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#available = undefined;
    this.#clearRefreshTimer();
  }

  #startMint(): Promise<GrokRealtimeCredential> {
    if (this.#disposed) {
      return Promise.reject(new Error("The Grok credential prewarmer is disposed."));
    }
    if (this.#available !== undefined) return Promise.resolve(this.#available);
    if (this.#inFlight !== undefined) return this.#inFlight;

    this.#attempts += 1;
    const inFlight = this.#options.mintCredential().then(
      (credential) => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
        if (!this.#disposed) {
          this.#available = credential;
          this.#lastError = null;
          this.#scheduleRefresh(credential);
        }
        return credential;
      },
      (error: unknown) => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
        this.#failures += 1;
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#options.onFailure?.(error);
        throw error;
      },
    );
    this.#inFlight = inFlight;
    /*
     * `prewarm()` often starts outside an awaited call path. Always attach a
     * rejection consumer, then additionally let the Durable Object retain the
     * work when it supplied a background owner. `take()` still observes the
     * original rejection and classifies call startup as failed.
     */
    const observed = inFlight.then(
      () => undefined,
      () => undefined,
    );
    this.#options.runInBackground?.(observed);
    return inFlight;
  }

  #scheduleRefresh(credential: GrokRealtimeCredential): void {
    this.#clearRefreshTimer();
    const remainingMs = credential.expiresAtEpochSeconds * 1_000 - this.#now();
    const refreshLeadMs = Math.min(
      GROK_CREDENTIAL_REFRESH_LEAD_MS,
      Math.max(1_000, remainingMs / 10),
    );
    const delayMs = Math.max(1_000, remainingMs - refreshLeadMs);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      if (this.#available !== credential || this.#disposed) return;
      this.#available = undefined;
      void this.#startMint();
    }, delayMs);
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer === undefined) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }
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

  return connectDeterministicPcm({
    createPair: options.createPair,
    createRenderer: () => {
      const render = createToneRenderer(options.frequencyHz, options.sampleRateHz);
      return { render };
    },
    durationMs: options.durationMs,
    sampleRateHz: options.sampleRateHz,
  });
}

/**
 * Connects the quiet six-response physical AEC fixture at the Grok seam.
 *
 * Full-duplex devices need materially different far-end challenges and two
 * matched-path controls. Keeping this out of `connectDeterministicTone` is a
 * safety boundary: the Stick's audible transport oracle retains its measured
 * 75%-scale tone, while residential AEC runs cannot accidentally inherit that
 * much louder source.
 */
export async function connectDeterministicAec(
  options: DeterministicAecOptions = {},
): Promise<WebSocket> {
  return connectDeterministicPcm({
    createPair: options.createPair,
    createRenderer: createDeterministicAecRenderer,
    durationMs: DETERMINISTIC_AEC_DURATION_MS,
    sampleRateHz: DETERMINISTIC_AEC_SAMPLE_RATE_HZ,
  });
}

interface DeterministicPcmOptions {
  createPair?: () => AcceptedSocketPair;
  createRenderer(responseIndex: number): DeterministicAecPcmRenderer;
  durationMs: number;
  sampleRateHz: number;
}

function connectDeterministicPcm(options: DeterministicPcmOptions): WebSocket {
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
  let stream: AbortController | undefined;
  let responseIndex = 0;
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
    let renderer: DeterministicAecPcmRenderer;
    try {
      renderer = options.createRenderer(responseIndex);
    } catch (error) {
      /*
       * An extra response means the harness and provider disagree about the
       * experiment. Emit a normal provider error rather than wrapping the
       * sequence or throwing out of an EventTarget callback, either of which
       * could leave a plausible but mislabelled acoustic capture behind.
       */
      pair.second.send(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
          type: "error",
        }),
      );
      return;
    }
    responseIndex += 1;
    stream = new AbortController();
    const current = stream;
    void streamDeterministicPcm(pair.second, renderer, options, current.signal).finally(() => {
      if (stream === current) stream = undefined;
    });
  });
  return provider;
}

/**
 * Mints one single-use xAI client credential through secret-confined egress.
 *
 * A direct API-key WebSocket would avoid this request, but the userspace
 * `project.egress.fetch()` surface is a serialized Cap'n Web capability call:
 * it cannot carry the native 101/WebSocket object back to this worker. A
 * production attempt stalled before receiving an upgrade. Keep this explicit
 * HTTPS mint until userspace has a native protocol-preserving egress lane.
 */
export async function mintGrokRealtimeCredential(
  options: GrokRealtimeCredentialOptions,
): Promise<GrokRealtimeCredential> {
  options.onStage?.({ atMs: Date.now(), code: "credential-prewarm-started" });
  const response = await options.fetchCredential(
    new Request("https://api.x.ai/v1/realtime/client_secrets", {
      body: JSON.stringify({
        expires_after: { seconds: XAI_CLIENT_SECRET_LIFETIME_SECONDS },
      }),
      headers: {
        authorization: `Bearer getSecret("${XAI_API_KEY_SECRET_PATH}")`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  options.onStage?.({ atMs: Date.now(), code: "credential-prewarm-received" });
  if (!response.ok) {
    throw new Error(`Grok client credential request failed with status ${response.status}.`);
  }
  const decoded: unknown = await response.json();
  if (!isGrokClientCredential(decoded)) {
    throw new Error("Grok returned a malformed client credential.");
  }
  if (decoded.expires_at * 1_000 - Date.now() <= GROK_CREDENTIAL_MINIMUM_REMAINING_MS) {
    throw new Error("Grok returned a client credential that expires too soon.");
  }
  options.onStage?.({ atMs: Date.now(), code: "credential-prewarm-decoded" });
  return {
    expiresAtEpochSeconds: decoded.expires_at,
    value: decoded.value,
  };
}

/**
 * Opens one xAI Voice 2.0 socket with raw PCM at the device's native rate.
 *
 * Credential acquisition is intentionally absent from this call-edge method.
 * In a measured production run it cost 2.67 seconds, while the actual xAI
 * WebSocket needed about 0.44 seconds. The owning PCM session prewarms the
 * single-use credential while the physical Stick is idle and hands it in here.
 */
export async function connectGrokRealtimeVoice(
  options: GrokRealtimeVoiceOptions,
): Promise<WebSocket> {
  if (!supportedPcmSampleRates.has(options.sampleRateHz)) {
    throw new Error(`Grok does not support ${options.sampleRateHz} Hz PCM audio.`);
  }
  if (
    options.credential.expiresAtEpochSeconds * 1_000 - Date.now() <=
    GROK_CREDENTIAL_MINIMUM_REMAINING_MS
  ) {
    throw new Error("The prewarmed Grok credential expired before connection.");
  }

  const endpoint = new URL("wss://api.x.ai/v1/realtime");
  endpoint.searchParams.set("model", options.model ?? "grok-voice-think-fast-2.0");
  const createWebSocket =
    options.createWebSocket ??
    ((url: string, protocols: readonly string[]) => new WebSocket(url, [...protocols]));
  const socket = createWebSocket(endpoint.href, [`xai-client-secret.${options.credential.value}`]);
  socket.binaryType = "arraybuffer";
  options.onStage?.({ atMs: Date.now(), code: "provider-websocket-created" });
  try {
    await waitForOpen(socket, options.connectTimeoutMs ?? 10_000);
    options.onStage?.({ atMs: Date.now(), code: "provider-websocket-opened" });
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { rate: options.sampleRateHz, type: "audio/pcm" },
              /*
               * The physical products in this proof are currently English
               * voice agents. Supplying the provider's explicit hint avoids
               * spending the first short greeting on language inference; it
               * does not rewrite or locally buffer microphone audio.
               */
              transcription: { language_hint: "en", model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: { rate: options.sampleRateHz, type: "audio/pcm" },
              transport: "binary",
            },
          },
          instructions: options.instructions ?? GROK_DEFAULT_INSTRUCTIONS,
          /*
           * Button B owns the lifetime of one conversation. Grok must retain
           * preceding PTT turns for that lifetime; otherwise repeated Button A
           * presses share a socket but behave like unrelated voice requests.
           */
          keep_context: true,
          /*
           * The authenticated firmware handshake chooses this once per PCM
           * generation. Manual PTT owns explicit commit markers; continuous
           * AEC delegates speech boundaries and natural barge-in to xAI. Do
           * not infer this from a device slug: that would split the shared
           * StackChan/HAVPE path and conceal firmware/worker disagreement.
           */
          tools: grokDeviceTools(options),
          turn_detection: providerTurnDetection(options.turnDetection, options.serverVadProfile),
          voice: options.voice ?? "eve",
        },
      }),
    );
    options.onStage?.({ atMs: Date.now(), code: "session-update-sent" });
    return socket;
  } catch (error) {
    socket.close(1000, "Grok connection setup failed.");
    throw error;
  }
}

function grokDeviceTools(options: GrokRealtimeVoiceOptions) {
  if (options.enableSpriteSetTool === false) return [];
  const emptyParameters = {
    additionalProperties: false,
    properties: {},
    type: "object",
  } as const;
  const tools = [
    {
      description:
        "Change the active Iterate Kit device to one of its compiled sprite sets. " +
        "When the user requests a face change without naming one, choose a suitable set yourself. " +
        "Spoken names map as follows: Dot Matrix Oracle to dot-matrix-oracle; " +
        "Karakuri Brass to karakuri-brass; Star Byte to starbyte.",
      name: "changeSpriteSet",
      parameters: {
        additionalProperties: false,
        properties: {
          spriteSet: { enum: KIT_SPRITE_SETS, type: "string" },
        },
        required: ["spriteSet"],
        type: "object",
      },
      type: "function",
    },
  ];
  if (options.deviceId !== "stackchan") return tools;
  return [
    ...tools,
    {
      description:
        "End the current voice conversation when the user explicitly asks to end, hang up, or go back to sleep. Do not ask for confirmation.",
      name: "endConversation",
      parameters: emptyParameters,
      type: "function",
    },
    {
      description:
        "Make StackChan physically nod its head once. Use alongside a clearly affirmative or agreeing spoken answer; for example, when asked ‘Are you there?’, nod and say ‘Yes, I’m here.’",
      name: "nod",
      parameters: emptyParameters,
      type: "function",
    },
    {
      description:
        "Make StackChan physically shake its head left and right once. Use alongside a clearly negative, disagreeing, or refusing spoken answer.",
      name: "shakeHead",
      parameters: emptyParameters,
      type: "function",
    },
  ];
}

function providerTurnDetection(
  mode: GrokRealtimeVoiceOptions["turnDetection"],
  profile: GrokServerVadProfile | undefined,
) {
  if (mode === "manual") {
    if (profile !== undefined) {
      throw new Error("A manual Grok session cannot configure a server-VAD profile.");
    }
    return { type: null } as const;
  }
  if (mode === "server-vad") {
    /*
     * Four hundred milliseconds of prefix protects the first phoneme.
     * Endpointing is one product-level latency policy: every continuous-AEC
     * target commits after 400 ms of quiet. Keeping it independent from the
     * named signal-level profiles prevents target-specific UX drift while the
     * profile still owns the genuinely different gain/threshold provenance.
     * This does not buffer or queue PCM; it tells provider VAD how long the
     * already-continuous input must stay quiet before committing one turn.
     */
    if (profile !== "low-level-aec" && profile !== "xmos-aec") {
      throw new Error("A server-VAD Grok session requires a calibrated input profile.");
    }
    return {
      prefix_padding_ms: 400,
      silence_duration_ms: 400,
      /*
       * Threshold is part of the measured DSP profile, not an echo filter.
       * Raising StackChan from 0.1 to 0.2 suppressed one assistant-echo false
       * edge but also missed deliberate nearby barge-in; 0.15 merely split two
       * known failures. The exact completed-speaker-DMA AEC reference must now
       * remove self-talk before provider VAD. Restore the measured near-speech
       * floor so double-talk remains audible, and reject the physical run if
       * assistant-only playback produces any VAD edge or transcript.
       * The production proof must still demonstrate both a real near-speech
       * edge and zero speaker-only edges before this calibration is accepted.
       *
       * HAVPE keeps 0.1 because its independently measured fixed-gain XMOS AEC
       * tap has a different envelope. Conflating the two here would conceal a
       * hardware calibration decision behind a shared provider default.
       */
      threshold: 0.1,
      type: "server_vad",
    } as const;
  }
  throw new Error(`Unsupported Grok turn detection mode: ${String(mode)}`);
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

async function streamDeterministicPcm(
  socket: WebSocket,
  renderer: DeterministicAecPcmRenderer,
  options: Pick<DeterministicPcmOptions, "durationMs" | "sampleRateHz">,
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
    const frame = renderer.render(samplesPerFrame);
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
    Number.isSafeInteger(value.expires_at) &&
    value.expires_at > 0 &&
    "value" in value &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    value.value.length <= 512
  );
}

function waitForOpen(socket: WebSocket, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The Grok WebSocket timeout must be a positive integer.");
  }
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
