export interface PcmDiagnosticCaptureSnapshot {
  finishedAtMonotonicMs: number;
  finishedAtMs: number;
  firstAcceptedAtMonotonicMs: number | null;
  firstAcceptedAtMs: number | null;
  firstAcceptedUplinkFrame: number | null;
  frameBytes: number;
  frames: number;
  lastAcceptedAtMonotonicMs: number | null;
  lastAcceptedAtMs: number | null;
  lastAcceptedUplinkFrame: number | null;
  maximumFrames: number;
  maximumInterFrameGapMs: number;
  pcm: Uint8Array;
  schemaVersion: 3;
  startedAtMonotonicMs: number;
  startedAtMs: number;
  truncatedFrames: number;
}

export type PcmDiagnosticCaptureStatus = Omit<
  PcmDiagnosticCaptureSnapshot,
  "finishedAtMonotonicMs" | "finishedAtMs" | "pcm" | "schemaVersion"
>;

/**
 * Raw conversational audio must never be recorded implicitly, but excluding
 * Grok entirely made the recorder useless for the exact failure it exists to
 * attribute: whether the provider received a damaged post-AEC waveform. The
 * safety boundary is therefore explicit arming plus a fixed frame ceiling,
 * not the provider selected for the current call. Manual/PTT sessions remain
 * excluded because this proof targets the continuously flowing, post-AEC lane.
 */
export function canStartPcmDiagnosticCapture(options: {
  audioMode: string;
  conversationActive: boolean;
}): boolean {
  return options.audioMode === "full-duplex-aec" && options.conversationActive;
}

/**
 * A deliberately opt-in, fixed-capacity recorder for physical audio proofs.
 *
 * The normal realtime bridge retains no microphone frames: each frame either
 * enters the current provider socket immediately or is visibly dropped. AEC
 * validation is the rare case where scalar peak/RMS metrics are insufficient;
 * the harness must compare the exact cleaned waveform with known far- and
 * near-end stimuli. This recorder preserves that separation by allocating its
 * complete budget at construction, copying only provider-accepted frames, and
 * counting overflow rather than growing or queueing. It belongs in userspace,
 * not firmware, so the device's scarce RAM and realtime schedule are unchanged.
 *
 * Every boundary deliberately carries two clocks. Epoch milliseconds let the
 * retained artifact correlate with router and device logs from other systems;
 * they are evidence, not an ordering primitive, because NTP may move them
 * backward. Monotonic milliseconds exclusively own duration and inter-frame
 * cadence. Schema 3 makes that split explicit instead of silently changing the
 * meaning of the older `*AtMs` fields.
 */
export class PcmDiagnosticCapture {
  readonly #frameBytes: number;
  readonly #maximumFrames: number;
  readonly #pcm: Uint8Array;
  readonly #startedAtMonotonicMs: number;
  readonly #startedAtMs: number;
  #firstAcceptedAtMonotonicMs: number | null = null;
  #firstAcceptedAtMs: number | null = null;
  #firstAcceptedUplinkFrame: number | null = null;
  #frames = 0;
  #lastAcceptedAtMonotonicMs: number | null = null;
  #lastAcceptedAtMs: number | null = null;
  #lastAcceptedUplinkFrame: number | null = null;
  #maximumInterFrameGapMs = 0;
  #truncatedFrames = 0;

  constructor(options: {
    frameBytes: number;
    maximumFrames: number;
    startedAtMonotonicMs: number;
    startedAtMs: number;
  }) {
    if (!Number.isSafeInteger(options.frameBytes) || options.frameBytes <= 0) {
      throw new Error("frameBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(options.maximumFrames) || options.maximumFrames <= 0) {
      throw new Error("maximumFrames must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(options.startedAtMs) || options.startedAtMs < 0) {
      throw new Error("startedAtMs must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(options.startedAtMonotonicMs) || options.startedAtMonotonicMs < 0) {
      throw new Error("startedAtMonotonicMs must be a non-negative safe integer.");
    }
    this.#frameBytes = options.frameBytes;
    this.#maximumFrames = options.maximumFrames;
    this.#pcm = new Uint8Array(options.frameBytes * options.maximumFrames);
    this.#startedAtMonotonicMs = options.startedAtMonotonicMs;
    this.#startedAtMs = options.startedAtMs;
  }

  observe(
    frame: Uint8Array,
    acceptedUplinkFrame: number,
    acceptedAtMs: number,
    acceptedAtMonotonicMs: number,
  ): boolean {
    if (frame.byteLength !== this.#frameBytes) {
      throw new Error(`A diagnostic PCM frame must contain exactly ${this.#frameBytes} bytes.`);
    }
    if (!Number.isSafeInteger(acceptedUplinkFrame) || acceptedUplinkFrame <= 0) {
      throw new Error("acceptedUplinkFrame must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(acceptedAtMs) || acceptedAtMs < 0) {
      throw new Error("acceptedAtMs must be a non-negative safe integer.");
    }
    if (
      !Number.isSafeInteger(acceptedAtMonotonicMs) ||
      acceptedAtMonotonicMs < this.#startedAtMonotonicMs
    ) {
      throw new Error(
        "acceptedAtMonotonicMs must be a safe integer no earlier than capture start.",
      );
    }
    if (this.#frames >= this.#maximumFrames) {
      this.#truncatedFrames += 1;
      return false;
    }
    if (this.#lastAcceptedAtMonotonicMs !== null) {
      if (acceptedAtMonotonicMs < this.#lastAcceptedAtMonotonicMs) {
        throw new Error("acceptedAtMonotonicMs must not move backward between retained frames.");
      }
      this.#maximumInterFrameGapMs = Math.max(
        this.#maximumInterFrameGapMs,
        acceptedAtMonotonicMs - this.#lastAcceptedAtMonotonicMs,
      );
    }
    if (
      this.#lastAcceptedUplinkFrame !== null &&
      acceptedUplinkFrame <= this.#lastAcceptedUplinkFrame
    ) {
      throw new Error("acceptedUplinkFrame must increase between retained frames.");
    }
    this.#pcm.set(frame, this.#frames * this.#frameBytes);
    this.#firstAcceptedAtMonotonicMs ??= acceptedAtMonotonicMs;
    this.#firstAcceptedAtMs ??= acceptedAtMs;
    this.#firstAcceptedUplinkFrame ??= acceptedUplinkFrame;
    this.#lastAcceptedAtMonotonicMs = acceptedAtMonotonicMs;
    this.#lastAcceptedAtMs = acceptedAtMs;
    this.#lastAcceptedUplinkFrame = acceptedUplinkFrame;
    this.#frames += 1;
    return true;
  }

  status(): PcmDiagnosticCaptureStatus {
    return {
      firstAcceptedAtMonotonicMs: this.#firstAcceptedAtMonotonicMs,
      firstAcceptedAtMs: this.#firstAcceptedAtMs,
      firstAcceptedUplinkFrame: this.#firstAcceptedUplinkFrame,
      frameBytes: this.#frameBytes,
      frames: this.#frames,
      lastAcceptedAtMonotonicMs: this.#lastAcceptedAtMonotonicMs,
      lastAcceptedAtMs: this.#lastAcceptedAtMs,
      lastAcceptedUplinkFrame: this.#lastAcceptedUplinkFrame,
      maximumFrames: this.#maximumFrames,
      maximumInterFrameGapMs: this.#maximumInterFrameGapMs,
      startedAtMonotonicMs: this.#startedAtMonotonicMs,
      startedAtMs: this.#startedAtMs,
      truncatedFrames: this.#truncatedFrames,
    };
  }

  snapshot(finishedAtMs: number, finishedAtMonotonicMs: number): PcmDiagnosticCaptureSnapshot {
    if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0) {
      throw new Error("finishedAtMs must be a non-negative safe integer.");
    }
    if (
      !Number.isSafeInteger(finishedAtMonotonicMs) ||
      finishedAtMonotonicMs < this.#startedAtMonotonicMs ||
      (this.#lastAcceptedAtMonotonicMs !== null &&
        finishedAtMonotonicMs < this.#lastAcceptedAtMonotonicMs)
    ) {
      throw new Error(
        "finishedAtMonotonicMs must be a safe integer no earlier than retained capture time.",
      );
    }
    return {
      finishedAtMonotonicMs,
      finishedAtMs,
      ...this.status(),
      /*
       * This is the capture's only size-dependent allocation. It happens after
       * the realtime interval and returns only populated evidence, never the
       * unused part of the declared ceiling.
       */
      pcm: this.#pcm.slice(0, this.#frames * this.#frameBytes),
      schemaVersion: 3,
    };
  }
}
