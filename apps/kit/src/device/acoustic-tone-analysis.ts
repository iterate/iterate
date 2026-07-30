import { open, stat } from "node:fs/promises";

export interface AcousticToneAnalysisOptions {
  expectedDurationMs: number;
  frequencyHz: number;
  minimumCoherence?: number;
  minimumToneAmplitude?: number;
  phaseDiscontinuityThresholdRadians?: number;
  samples: Int16Array;
  sampleRateHz: number;
  windowDurationMs?: number;
}

export interface AcousticToneArtifactAnalysisOptions {
  artifactPath: string;
  expectedDurationMs: number;
  frequencyHz: number;
  minimumCoherence?: number;
  minimumToneAmplitude?: number;
  phaseDiscontinuityThresholdRadians?: number;
  readChunkBytes?: number;
  sampleRateHz: number;
  windowDurationMs?: number;
}

export interface AcousticToneAnalysis {
  activeWindowCount: number;
  amplitudeCoefficientOfVariation: number;
  maximumAmplitudeStepDecibels: number;
  amplitudeStepP99Decibels: number;
  expectedDurationMs: number;
  gapCount: number;
  longestInternalGapMs: number;
  maximumPhaseStepErrorRadians: number;
  medianToneAmplitude: number;
  medianPhaseStepRadians: number;
  missingToneMs: number;
  observedEndMs: number | undefined;
  observedSpanMs: number;
  observedStartMs: number | undefined;
  phaseDiscontinuityCount: number;
  phaseDiscontinuityThresholdRadians: number;
  phaseStepSpanMs: number;
  sampleRateHz: number;
  toneFrequencyHz: number;
  toneWindowRatio: number;
  totalDurationMs: number;
  windowDurationMs: number;
  windowStepMs: number;
}

export interface AcousticToneArtifactAnalysis extends AcousticToneAnalysis {
  /**
   * PCM bytes simultaneously retained by the analyzer itself.
   *
   * This excludes the on-disk artifact, fixed-size numeric histograms, and
   * Node's engine overhead. Keeping the bulk audio bound observable prevents a
   * later `readFile()` refactor from silently making endurance duration a heap
   * multiplier.
   */
  maximumBufferedAudioBytes: number;
}

export interface AcousticToneThresholds {
  maximumAmplitudeStepDecibels: number;
  maximumAmplitudeStepP99Decibels: number;
  maximumDurationErrorMs: number;
  maximumInternalGapMs: number;
  maximumMissingToneMs: number;
  maximumPhaseStepErrorRadians: number;
}

export interface AcousticToneAssessment {
  passed: boolean;
  reasons: string[];
}

interface ToneWindow {
  active: boolean;
  amplitude: number;
  phaseRadians: number;
}

interface IndexedToneWindow extends ToneWindow {
  index: number;
}

interface StableToneWindow extends IndexedToneWindow {
  active: boolean;
}

/*
 * Five milliseconds is the coarsest default compatible with a zero-gap
 * endurance policy. A ten-millisecond window can straddle a five-millisecond
 * silence and retain enough coherent energy to call both halves active,
 * creating a false green for an audible click.
 */
const defaultWindowDurationMs = 5;
const defaultMinimumToneAmplitude = 128;
const defaultMinimumCoherence = 0.7;
const defaultPhaseDiscontinuityThresholdRadians = 0.1;
const minimumStableRunWindows = 2;
const defaultReadChunkBytes = 64 * 1_024;
const amplitudeHistogramBins = 4_096;
const amplitudeStepHistogramMaximumDecibels = 96;
const amplitudeStepEdgeContextWindows = 2;
const phaseHistogramBins = 8_192;

/**
 * Finds a deterministic sine tone in signed PCM captured by a nearby
 * microphone.
 *
 * Digital queue counters cannot prove that the codec produced a continuous
 * pressure wave. This analyzer is deliberately independent of the firmware:
 * it correlates short room-recording windows against the known sine and
 * reports holes inside the first-to-last stable tone span.
 *
 * Correlation is preferable to a raw volume threshold. Fans, speech, and USB
 * noise can all have non-zero RMS; only energy phase-coherent with the expected
 * frequency counts as the device tone. Five-millisecond windows make a jiggle
 * visible without letting individual microphone samples or codec-edge
 * transients manufacture thousands of tiny "gaps."
 *
 * This synchronous entry point is for small fixtures that are already in
 * memory. Physical endurance runs must use `analyzeAcousticTonePcm16Artifact`;
 * accepting an Int16Array here makes the caller—not this function—the owner of
 * the whole-recording allocation.
 */
export function analyzeAcousticTonePcm16(
  options: AcousticToneAnalysisOptions,
): AcousticToneAnalysis {
  validateOptions(options);
  const requestedWindowDurationMs = options.windowDurationMs ?? defaultWindowDurationMs;
  const windowSamples = Math.round((options.sampleRateHz * requestedWindowDurationMs) / 1_000);
  if (windowSamples < 8) {
    throw new Error("The acoustic analysis window must contain at least eight samples.");
  }
  const windowDurationMs = (windowSamples * 1_000) / options.sampleRateHz;
  /*
   * Half-window overlap removes dependence on one arbitrary origin. Without
   * it, a silence beginning halfway through one window can leave two
   * half-tone windows that both clear the coherence threshold.
   */
  const windowStepSamples = Math.max(1, Math.floor(windowSamples / 2));
  const windowStepMs = (windowStepSamples * 1_000) / options.sampleRateHz;
  const windowCount = 1 + Math.floor((options.samples.length - windowSamples) / windowStepSamples);
  if (windowCount <= 0) {
    throw new Error("The acoustic recording is shorter than one analysis window.");
  }
  const phaseStepWindowCount = Math.max(1, Math.round(windowSamples / windowStepSamples));

  const windows: ToneWindow[] = [];
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    windows.push(
      analyzeWindow(
        options.samples,
        windowIndex * windowStepSamples,
        windowSamples,
        options.sampleRateHz,
        options.frequencyHz,
        options.minimumToneAmplitude ?? defaultMinimumToneAmplitude,
        options.minimumCoherence ?? defaultMinimumCoherence,
      ),
    );
  }
  /*
   * A single coincidental short correlation is not playback onset. Require two
   * adjacent windows, while retaining every window in a longer run. Internal
   * holes remain holes; this operation only removes isolated false positives
   * before and after the device's actual output.
   */
  const stableActive = retainStableRuns(
    windows.map((window) => window.active),
    minimumStableRunWindows,
  );
  const firstActive = stableActive.indexOf(true);
  const lastActive = stableActive.lastIndexOf(true);
  const activeWindowCount = stableActive.reduce((total, active) => total + (active ? 1 : 0), 0);
  const activeAmplitudes = windows
    .filter((_, index) => stableActive[index])
    .map((window) => window.amplitude);
  const amplitudeStepsDecibels = measureActiveAmplitudeStepsDecibels(windows, stableActive);
  const observedSpanWindows = firstActive === -1 ? 0 : lastActive - firstActive + 1;
  const gapMetrics = measureInternalGaps(stableActive, firstActive, lastActive);
  const activeToneMs = measureActiveToneDuration(stableActive, windowDurationMs, windowStepMs);
  const phaseMetrics = measurePhaseContinuity(
    windows,
    stableActive,
    phaseStepWindowCount,
    options.phaseDiscontinuityThresholdRadians ?? defaultPhaseDiscontinuityThresholdRadians,
  );

  return {
    activeWindowCount,
    amplitudeCoefficientOfVariation: coefficientOfVariation(activeAmplitudes),
    amplitudeStepP99Decibels: percentile(amplitudeStepsDecibels, 0.99),
    maximumAmplitudeStepDecibels: Math.max(0, ...amplitudeStepsDecibels),
    expectedDurationMs: options.expectedDurationMs,
    gapCount: gapMetrics.count,
    longestInternalGapMs: gapMetrics.longestWindows * windowStepMs,
    maximumPhaseStepErrorRadians: phaseMetrics.maximumErrorRadians,
    medianToneAmplitude: median(activeAmplitudes),
    medianPhaseStepRadians: phaseMetrics.medianStepRadians,
    missingToneMs: Math.max(0, options.expectedDurationMs - activeToneMs),
    observedEndMs: lastActive === -1 ? undefined : lastActive * windowStepMs + windowDurationMs,
    observedSpanMs:
      observedSpanWindows === 0 ? 0 : (observedSpanWindows - 1) * windowStepMs + windowDurationMs,
    observedStartMs: firstActive === -1 ? undefined : firstActive * windowStepMs,
    phaseDiscontinuityCount: phaseMetrics.discontinuityCount,
    phaseDiscontinuityThresholdRadians:
      options.phaseDiscontinuityThresholdRadians ?? defaultPhaseDiscontinuityThresholdRadians,
    phaseStepSpanMs: phaseStepWindowCount * windowStepMs,
    sampleRateHz: options.sampleRateHz,
    toneFrequencyHz: options.frequencyHz,
    toneWindowRatio: observedSpanWindows === 0 ? 0 : activeWindowCount / observedSpanWindows,
    totalDurationMs: (options.samples.length * 1_000) / options.sampleRateHz,
    windowDurationMs,
    windowStepMs,
  };
}

/**
 * Analyzes a retained PCM16LE microphone artifact without materializing it.
 *
 * Endurance duration must be a time cost, never a resident-memory cost. The
 * reader therefore owns exactly one caller-sized byte buffer and one
 * correlation window. It scans the artifact twice: pass one finds the robust
 * median phase step, while pass two measures deviations from that baseline.
 * Two bounded passes are preferable to retaining every phase step or letting
 * early samples define a baseline that an isolated glitch can poison.
 */
export async function analyzeAcousticTonePcm16Artifact(
  options: AcousticToneArtifactAnalysisOptions,
): Promise<AcousticToneArtifactAnalysis> {
  validateAnalysisConfiguration(options);
  if (!options.artifactPath) {
    throw new Error("The acoustic artifact path must not be empty.");
  }
  const readChunkBytes = options.readChunkBytes ?? defaultReadChunkBytes;
  if (!Number.isSafeInteger(readChunkBytes) || readChunkBytes <= 0 || readChunkBytes % 2 !== 0) {
    throw new Error(
      "The acoustic read chunk must contain a positive whole number of PCM16 samples.",
    );
  }
  const artifactStatus = await stat(options.artifactPath);
  if (artifactStatus.size === 0) {
    throw new Error("The acoustic recording must contain PCM16 samples.");
  }
  if (artifactStatus.size % 2 !== 0) {
    throw new Error("The acoustic artifact must contain whole PCM16 samples.");
  }

  const requestedWindowDurationMs = options.windowDurationMs ?? defaultWindowDurationMs;
  const windowSamples = Math.round((options.sampleRateHz * requestedWindowDurationMs) / 1_000);
  if (windowSamples < 8) {
    throw new Error("The acoustic analysis window must contain at least eight samples.");
  }
  const totalSamples = artifactStatus.size / 2;
  if (totalSamples < windowSamples) {
    throw new Error("The acoustic recording is shorter than one analysis window.");
  }
  const windowStepSamples = Math.max(1, Math.floor(windowSamples / 2));
  const windowDurationMs = (windowSamples * 1_000) / options.sampleRateHz;
  const windowStepMs = (windowStepSamples * 1_000) / options.sampleRateHz;
  const phaseStepWindowCount = Math.max(1, Math.round(windowSamples / windowStepSamples));
  const reader = new ArtifactToneWindowReader({
    artifactPath: options.artifactPath,
    artifactBytes: artifactStatus.size,
    frequencyHz: options.frequencyHz,
    minimumCoherence: options.minimumCoherence ?? defaultMinimumCoherence,
    minimumToneAmplitude: options.minimumToneAmplitude ?? defaultMinimumToneAmplitude,
    readChunkBytes,
    sampleRateHz: options.sampleRateHz,
    windowSamples,
    windowStepSamples,
  });

  try {
    const firstPass = new FirstToneAnalysisPass(phaseStepWindowCount);
    for await (const window of retainStableArtifactRuns(reader.windows())) {
      firstPass.observe(window);
    }
    const firstPassResult = firstPass.finish();

    /*
     * A phase-step threshold is meaningful only relative to the steady clock
     * relationship between speaker and microphone. Re-read the file after
     * finding that relationship rather than storing O(duration) steps.
     */
    const phaseMetrics = new PhaseContinuityPass(
      phaseStepWindowCount,
      firstPassResult.medianPhaseStepRadians,
      options.phaseDiscontinuityThresholdRadians ?? defaultPhaseDiscontinuityThresholdRadians,
    );
    for await (const window of retainStableArtifactRuns(reader.windows())) {
      phaseMetrics.observe(window);
    }

    const observedSpanWindows =
      firstPassResult.firstActiveIndex === undefined ||
      firstPassResult.lastActiveIndex === undefined
        ? 0
        : firstPassResult.lastActiveIndex - firstPassResult.firstActiveIndex + 1;
    const activeToneMs =
      firstPassResult.activeWindowCount === 0
        ? 0
        : firstPassResult.activeWindowCount * windowStepMs +
          firstPassResult.activeRunCount * (windowDurationMs - windowStepMs);
    return {
      activeWindowCount: firstPassResult.activeWindowCount,
      amplitudeCoefficientOfVariation: firstPassResult.amplitudeCoefficientOfVariation,
      amplitudeStepP99Decibels: firstPassResult.amplitudeStepP99Decibels,
      maximumAmplitudeStepDecibels: firstPassResult.maximumAmplitudeStepDecibels,
      expectedDurationMs: options.expectedDurationMs,
      gapCount: firstPassResult.gapCount,
      longestInternalGapMs: firstPassResult.longestInternalGapWindows * windowStepMs,
      maximumBufferedAudioBytes: readChunkBytes + windowSamples * Int16Array.BYTES_PER_ELEMENT,
      maximumPhaseStepErrorRadians: phaseMetrics.maximumErrorRadians,
      medianToneAmplitude: firstPassResult.medianToneAmplitude,
      medianPhaseStepRadians: firstPassResult.medianPhaseStepRadians,
      missingToneMs: Math.max(0, options.expectedDurationMs - activeToneMs),
      observedEndMs:
        firstPassResult.lastActiveIndex === undefined
          ? undefined
          : firstPassResult.lastActiveIndex * windowStepMs + windowDurationMs,
      observedSpanMs:
        observedSpanWindows === 0 ? 0 : (observedSpanWindows - 1) * windowStepMs + windowDurationMs,
      observedStartMs:
        firstPassResult.firstActiveIndex === undefined
          ? undefined
          : firstPassResult.firstActiveIndex * windowStepMs,
      phaseDiscontinuityCount: phaseMetrics.discontinuityCount,
      phaseDiscontinuityThresholdRadians:
        options.phaseDiscontinuityThresholdRadians ?? defaultPhaseDiscontinuityThresholdRadians,
      phaseStepSpanMs: phaseStepWindowCount * windowStepMs,
      sampleRateHz: options.sampleRateHz,
      toneFrequencyHz: options.frequencyHz,
      toneWindowRatio:
        observedSpanWindows === 0 ? 0 : firstPassResult.activeWindowCount / observedSpanWindows,
      totalDurationMs: (totalSamples * 1_000) / options.sampleRateHz,
      windowDurationMs,
      windowStepMs,
    };
  } finally {
    await reader.close();
  }
}

interface ArtifactToneWindowReaderOptions {
  artifactPath: string;
  artifactBytes: number;
  frequencyHz: number;
  minimumCoherence: number;
  minimumToneAmplitude: number;
  readChunkBytes: number;
  sampleRateHz: number;
  windowSamples: number;
  windowStepSamples: number;
}

/**
 * Reusable two-pass reader whose only audio storage is fixed at construction.
 *
 * Giving both passes the same reader matters for the memory proof: creating a
 * second stream could leave the first stream's high-water-mark buffer waiting
 * for garbage collection. Explicit positional reads into this one Buffer make
 * the bound independent of Node stream scheduling and garbage-collector timing.
 */
class ArtifactToneWindowReader {
  readonly #artifactBytes: number;
  readonly #frequencyHz: number;
  readonly #handle;
  readonly #minimumCoherence: number;
  readonly #minimumToneAmplitude: number;
  readonly #readBuffer: Buffer;
  readonly #sampleRateHz: number;
  readonly #window: Int16Array;
  readonly #windowStepSamples: number;

  constructor(options: ArtifactToneWindowReaderOptions) {
    this.#artifactBytes = options.artifactBytes;
    this.#frequencyHz = options.frequencyHz;
    this.#handle = open(options.artifactPath, "r");
    this.#minimumCoherence = options.minimumCoherence;
    this.#minimumToneAmplitude = options.minimumToneAmplitude;
    this.#readBuffer = Buffer.allocUnsafe(options.readChunkBytes);
    this.#sampleRateHz = options.sampleRateHz;
    this.#window = new Int16Array(options.windowSamples);
    this.#windowStepSamples = options.windowStepSamples;
  }

  async *windows(): AsyncGenerator<IndexedToneWindow> {
    const handle = await this.#handle;
    let artifactOffset = 0;
    let sampleCount = 0;
    let windowIndex = 0;
    while (artifactOffset < this.#artifactBytes) {
      const requestedBytes = Math.min(
        this.#readBuffer.byteLength,
        this.#artifactBytes - artifactOffset,
      );
      const { bytesRead } = await handle.read(this.#readBuffer, 0, requestedBytes, artifactOffset);
      if (bytesRead === 0) {
        throw new Error("The acoustic artifact ended before its reported file size.");
      }
      if (bytesRead % 2 !== 0) {
        throw new Error("The acoustic artifact reader received a truncated PCM16 sample.");
      }
      for (let byteOffset = 0; byteOffset < bytesRead; byteOffset += 2) {
        this.#window[sampleCount % this.#window.length] = this.#readBuffer.readInt16LE(byteOffset);
        sampleCount += 1;
        if (sampleCount < this.#window.length) continue;
        if ((sampleCount - this.#window.length) % this.#windowStepSamples !== 0) {
          continue;
        }
        const windowStart = sampleCount - this.#window.length;
        yield {
          ...analyzeRingWindow(
            this.#window,
            windowStart,
            this.#sampleRateHz,
            this.#frequencyHz,
            this.#minimumToneAmplitude,
            this.#minimumCoherence,
          ),
          index: windowIndex,
        };
        windowIndex += 1;
      }
      artifactOffset += bytesRead;
    }
  }

  async close() {
    const handle = await this.#handle;
    await handle.close();
  }
}

/**
 * Converts raw correlation decisions into stable decisions with bounded
 * lookahead. It emits in original order and retains fewer than the configured
 * minimum run of candidates, so rejecting isolated room-noise coincidences
 * does not require an O(duration) boolean array.
 */
async function* retainStableArtifactRuns(
  windows: AsyncIterable<IndexedToneWindow>,
): AsyncGenerator<StableToneWindow> {
  const pendingRun: IndexedToneWindow[] = [];
  let insideStableRun = false;
  for await (const window of windows) {
    if (!window.active) {
      for (const pendingWindow of pendingRun) {
        yield { ...pendingWindow, active: false };
      }
      pendingRun.length = 0;
      insideStableRun = false;
      yield { ...window, active: false };
      continue;
    }
    if (insideStableRun) {
      yield { ...window, active: true };
      continue;
    }
    pendingRun.push(window);
    if (pendingRun.length < minimumStableRunWindows) {
      continue;
    }
    for (const pendingWindow of pendingRun) {
      yield { ...pendingWindow, active: true };
    }
    pendingRun.length = 0;
    insideStableRun = true;
  }
  for (const pendingWindow of pendingRun) {
    yield { ...pendingWindow, active: false };
  }
}

function analyzeRingWindow(
  samples: Int16Array,
  absoluteOffset: number,
  sampleRateHz: number,
  frequencyHz: number,
  minimumToneAmplitude: number,
  minimumCoherence: number,
): ToneWindow {
  const radiansPerSample = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const cosineStep = Math.cos(radiansPerSample);
  const sineStep = Math.sin(radiansPerSample);
  let cosine = Math.cos(radiansPerSample * absoluteOffset);
  let sine = Math.sin(radiansPerSample * absoluteOffset);
  let cosineProjection = 0;
  let sineProjection = 0;
  let squareSum = 0;
  for (let relativeIndex = 0; relativeIndex < samples.length; relativeIndex += 1) {
    const sample = samples[(absoluteOffset + relativeIndex) % samples.length]!;
    cosineProjection += sample * cosine;
    sineProjection += sample * sine;
    squareSum += sample * sample;
    /*
     * The ten-minute 48 kHz proof evaluates roughly 240,000 overlapping
     * windows twice. Advancing the reference oscillator algebraically avoids
     * hundreds of millions of host trig calls, while restarting it from the
     * absolute offset every 5 ms prevents recurrence error from accumulating
     * across the recording.
     */
    const nextCosine = cosine * cosineStep - sine * sineStep;
    sine = sine * cosineStep + cosine * sineStep;
    cosine = nextCosine;
  }
  const amplitude = (2 * Math.hypot(cosineProjection, sineProjection)) / samples.length;
  const rootMeanSquare = Math.sqrt(squareSum / samples.length);
  const coherence =
    rootMeanSquare === 0 ? 0 : Math.min(1, amplitude / (Math.SQRT2 * rootMeanSquare));
  return {
    active: amplitude >= minimumToneAmplitude && coherence >= minimumCoherence,
    amplitude,
    phaseRadians: Math.atan2(cosineProjection, sineProjection),
  };
}

/**
 * Fixed bins trade imperceptible quantization for a hard memory ceiling.
 *
 * Exact medians require retaining every value. The amplitude bin width is 16
 * PCM units and the phase bin width is under 0.001 rad, both far below the
 * physical thresholds. Unlike reservoir sampling, this result is deterministic
 * and cannot overlook a rare run based on random replacement.
 */
class BoundedHistogram {
  readonly #bins: Uint32Array;
  readonly #maximum: number;
  readonly #minimum: number;
  #count = 0;

  constructor(minimum: number, maximum: number, binCount: number) {
    this.#minimum = minimum;
    this.#maximum = maximum;
    this.#bins = new Uint32Array(binCount);
  }

  observe(value: number) {
    const bounded = Math.min(this.#maximum, Math.max(this.#minimum, value));
    const normalized = (bounded - this.#minimum) / (this.#maximum - this.#minimum);
    const index = Math.min(this.#bins.length - 1, Math.floor(normalized * this.#bins.length));
    this.#bins[index] += 1;
    this.#count += 1;
  }

  median() {
    return this.quantile(0.5);
  }

  quantile(fraction: number) {
    if (this.#count === 0) return 0;
    const target = Math.ceil(this.#count * fraction);
    let cumulative = 0;
    for (let index = 0; index < this.#bins.length; index += 1) {
      cumulative += this.#bins[index]!;
      if (cumulative < target) continue;
      const binWidth = (this.#maximum - this.#minimum) / this.#bins.length;
      return this.#minimum + (index + 0.5) * binWidth;
    }
    throw new Error("The bounded histogram lost an observed value.");
  }
}

class FirstToneAnalysisPass {
  readonly #amplitudes = new BoundedHistogram(0, 65_536, amplitudeHistogramBins);
  readonly #amplitudeStepsDecibels = new BoundedHistogram(
    0,
    amplitudeStepHistogramMaximumDecibels,
    amplitudeHistogramBins,
  );
  readonly #amplitudeRecent: StableToneWindow[] = [];
  readonly #phaseSteps = new BoundedHistogram(-Math.PI, Math.PI, phaseHistogramBins);
  readonly #phaseStepWindowCount: number;
  readonly #recent: StableToneWindow[] = [];
  #activeAmplitudeMean = 0;
  #activeAmplitudeM2 = 0;
  #activeRunCount = 0;
  #activeWindowCount = 0;
  #firstActiveIndex: number | undefined;
  #gapCount = 0;
  #lastActiveIndex: number | undefined;
  #longestInternalGapWindows = 0;
  #pendingGapWindows = 0;
  #previousActive = false;
  #maximumAmplitudeStepDecibels = 0;

  constructor(phaseStepWindowCount: number) {
    this.#phaseStepWindowCount = phaseStepWindowCount;
  }

  observe(window: StableToneWindow) {
    this.#amplitudeRecent.push(window);
    if (this.#amplitudeRecent.length > amplitudeStepEdgeContextWindows * 2 + 2) {
      this.#amplitudeRecent.shift();
    }
    if (
      this.#amplitudeRecent.length === amplitudeStepEdgeContextWindows * 2 + 2 &&
      this.#amplitudeRecent.every((recentWindow) => recentWindow.active)
    ) {
      const left = this.#amplitudeRecent[amplitudeStepEdgeContextWindows]!;
      const right = this.#amplitudeRecent[amplitudeStepEdgeContextWindows + 1]!;
      const step = amplitudeStepDecibels(left.amplitude, right.amplitude);
      this.#amplitudeStepsDecibels.observe(step);
      this.#maximumAmplitudeStepDecibels = Math.max(this.#maximumAmplitudeStepDecibels, step);
    }

    this.#recent.push(window);
    if (this.#recent.length > this.#phaseStepWindowCount + 1) {
      this.#recent.shift();
    }

    if (!window.active) {
      if (this.#firstActiveIndex !== undefined) {
        this.#pendingGapWindows += 1;
      }
      this.#previousActive = false;
      return;
    }

    if (this.#pendingGapWindows > 0) {
      this.#gapCount += 1;
      this.#longestInternalGapWindows = Math.max(
        this.#longestInternalGapWindows,
        this.#pendingGapWindows,
      );
      this.#pendingGapWindows = 0;
    }
    if (!this.#previousActive) {
      this.#activeRunCount += 1;
    }
    this.#previousActive = true;
    this.#firstActiveIndex ??= window.index;
    this.#lastActiveIndex = window.index;
    this.#activeWindowCount += 1;
    this.#amplitudes.observe(window.amplitude);
    const amplitudeDelta = window.amplitude - this.#activeAmplitudeMean;
    this.#activeAmplitudeMean += amplitudeDelta / this.#activeWindowCount;
    this.#activeAmplitudeM2 += amplitudeDelta * (window.amplitude - this.#activeAmplitudeMean);

    if (
      this.#recent.length === this.#phaseStepWindowCount + 1 &&
      this.#recent.every((recentWindow) => recentWindow.active)
    ) {
      this.#phaseSteps.observe(wrapRadians(window.phaseRadians - this.#recent[0]!.phaseRadians));
    }
  }

  finish() {
    const amplitudeVariance =
      this.#activeWindowCount === 0 ? 0 : this.#activeAmplitudeM2 / this.#activeWindowCount;
    return {
      activeRunCount: this.#activeRunCount,
      activeWindowCount: this.#activeWindowCount,
      amplitudeCoefficientOfVariation:
        this.#activeAmplitudeMean === 0
          ? 0
          : Math.sqrt(amplitudeVariance) / this.#activeAmplitudeMean,
      amplitudeStepP99Decibels: this.#amplitudeStepsDecibels.quantile(0.99),
      maximumAmplitudeStepDecibels: this.#maximumAmplitudeStepDecibels,
      firstActiveIndex: this.#firstActiveIndex,
      gapCount: this.#gapCount,
      lastActiveIndex: this.#lastActiveIndex,
      longestInternalGapWindows: this.#longestInternalGapWindows,
      medianPhaseStepRadians: this.#phaseSteps.median(),
      medianToneAmplitude: this.#amplitudes.median(),
    };
  }
}

class PhaseContinuityPass {
  readonly #baselineRadians: number;
  readonly #phaseStepWindowCount: number;
  readonly #recent: StableToneWindow[] = [];
  readonly #thresholdRadians: number;
  discontinuityCount = 0;
  maximumErrorRadians = 0;

  constructor(phaseStepWindowCount: number, baselineRadians: number, thresholdRadians: number) {
    this.#phaseStepWindowCount = phaseStepWindowCount;
    this.#baselineRadians = baselineRadians;
    this.#thresholdRadians = thresholdRadians;
  }

  observe(window: StableToneWindow) {
    this.#recent.push(window);
    if (this.#recent.length > this.#phaseStepWindowCount + 1) {
      this.#recent.shift();
    }
    if (
      this.#recent.length !== this.#phaseStepWindowCount + 1 ||
      !this.#recent.every((recentWindow) => recentWindow.active)
    ) {
      return;
    }
    const step = wrapRadians(window.phaseRadians - this.#recent[0]!.phaseRadians);
    const error = Math.abs(wrapRadians(step - this.#baselineRadians));
    this.maximumErrorRadians = Math.max(this.maximumErrorRadians, error);
    if (error > this.#thresholdRadians) {
      this.discontinuityCount += 1;
    }
  }
}

/**
 * Applies explicit physical-pass thresholds without hiding the measurements.
 *
 * Returning every reason is important for tuning: a short recording and an
 * internal 50 ms dropout are different defects and should not collapse into a
 * generic false result.
 */
export function assessAcousticToneAnalysis(
  analysis: AcousticToneAnalysis,
  thresholds: AcousticToneThresholds,
): AcousticToneAssessment {
  const reasons: string[] = [];
  if (analysis.maximumAmplitudeStepDecibels > thresholds.maximumAmplitudeStepDecibels) {
    reasons.push(
      `maximum amplitude step ` +
        `${formatDecibels(analysis.maximumAmplitudeStepDecibels)} exceeds ` +
        `${formatDecibels(thresholds.maximumAmplitudeStepDecibels)}`,
    );
  }
  if (analysis.amplitudeStepP99Decibels > thresholds.maximumAmplitudeStepP99Decibels) {
    reasons.push(
      `99th-percentile amplitude step ` +
        `${formatDecibels(analysis.amplitudeStepP99Decibels)} exceeds ` +
        `${formatDecibels(thresholds.maximumAmplitudeStepP99Decibels)}`,
    );
  }
  const durationErrorMs = Math.abs(analysis.observedSpanMs - analysis.expectedDurationMs);
  if (durationErrorMs > thresholds.maximumDurationErrorMs) {
    reasons.push(
      `tone duration error ${formatMilliseconds(durationErrorMs)} exceeds ` +
        `${formatMilliseconds(thresholds.maximumDurationErrorMs)}`,
    );
  }
  if (analysis.longestInternalGapMs > thresholds.maximumInternalGapMs) {
    reasons.push(
      `longest internal gap ${formatMilliseconds(analysis.longestInternalGapMs)} ` +
        `exceeds ${formatMilliseconds(thresholds.maximumInternalGapMs)}`,
    );
  }
  if (analysis.missingToneMs > thresholds.maximumMissingToneMs) {
    reasons.push(
      `missing tone ${formatMilliseconds(analysis.missingToneMs)} exceeds ` +
        `${formatMilliseconds(thresholds.maximumMissingToneMs)}`,
    );
  }
  if (analysis.maximumPhaseStepErrorRadians > thresholds.maximumPhaseStepErrorRadians) {
    reasons.push(
      `maximum phase-step error ` +
        `${formatRadians(analysis.maximumPhaseStepErrorRadians)} exceeds ` +
        `${formatRadians(thresholds.maximumPhaseStepErrorRadians)}`,
    );
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function analyzeWindow(
  samples: Int16Array,
  offset: number,
  sampleCount: number,
  sampleRateHz: number,
  frequencyHz: number,
  minimumToneAmplitude: number,
  minimumCoherence: number,
): ToneWindow {
  const radiansPerSample = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const cosineStep = Math.cos(radiansPerSample);
  const sineStep = Math.sin(radiansPerSample);
  let cosine = Math.cos(radiansPerSample * offset);
  let sine = Math.sin(radiansPerSample * offset);
  let cosineProjection = 0;
  let sineProjection = 0;
  let squareSum = 0;
  for (let relativeIndex = 0; relativeIndex < sampleCount; relativeIndex += 1) {
    const sample = samples[offset + relativeIndex]!;
    cosineProjection += sample * cosine;
    sineProjection += sample * sine;
    squareSum += sample * sample;
    const nextCosine = cosine * cosineStep - sine * sineStep;
    sine = sine * cosineStep + cosine * sineStep;
    cosine = nextCosine;
  }
  const amplitude = (2 * Math.hypot(cosineProjection, sineProjection)) / sampleCount;
  const rootMeanSquare = Math.sqrt(squareSum / sampleCount);
  /*
   * A pure sine with peak A has RMS A/sqrt(2), so this normalized coherence is
   * one. Clamp floating-point/edge leakage above one; silence remains zero
   * instead of dividing by zero.
   */
  const coherence =
    rootMeanSquare === 0 ? 0 : Math.min(1, amplitude / (Math.SQRT2 * rootMeanSquare));
  return {
    active: amplitude >= minimumToneAmplitude && coherence >= minimumCoherence,
    amplitude,
    /*
     * For x[n] = A sin(wn + phi), the sine projection is proportional
     * to cos(phi) and the cosine projection to sin(phi). Magnitude says only
     * that a tone exists; retaining this angle is what exposes duplicated or
     * skipped full frames whose energy never disappears.
     */
    phaseRadians: Math.atan2(cosineProjection, sineProjection),
  };
}

function retainStableRuns(active: readonly boolean[], minimumRunLength: number) {
  const stable = new Array<boolean>(active.length).fill(false);
  let runStart = 0;
  while (runStart < active.length) {
    if (!active[runStart]) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < active.length && active[runEnd]) {
      runEnd += 1;
    }
    if (runEnd - runStart >= minimumRunLength) {
      stable.fill(true, runStart, runEnd);
    }
    runStart = runEnd;
  }
  return stable;
}

function measureInternalGaps(active: readonly boolean[], firstActive: number, lastActive: number) {
  if (firstActive === -1 || lastActive === -1) {
    return { count: 0, longestWindows: 0 };
  }
  let count = 0;
  let longestWindows = 0;
  let index = firstActive;
  while (index <= lastActive) {
    if (active[index]) {
      index += 1;
      continue;
    }
    const gapStart = index;
    while (index <= lastActive && !active[index]) {
      index += 1;
    }
    count += 1;
    longestWindows = Math.max(longestWindows, index - gapStart);
  }
  return { count, longestWindows };
}

function measureActiveToneDuration(
  active: readonly boolean[],
  windowDurationMs: number,
  windowStepMs: number,
) {
  let durationMs = 0;
  let runStart = 0;
  while (runStart < active.length) {
    if (!active[runStart]) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < active.length && active[runEnd]) {
      runEnd += 1;
    }
    durationMs += windowDurationMs + (runEnd - runStart - 1) * windowStepMs;
    runStart = runEnd;
  }
  return durationMs;
}

function measureActiveAmplitudeStepsDecibels(
  windows: readonly ToneWindow[],
  active: readonly boolean[],
) {
  const steps: number[] = [];
  let runStart = 0;
  while (runStart < windows.length) {
    if (!active[runStart]) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < windows.length && active[runEnd]) {
      runEnd += 1;
    }
    for (
      let rightIndex = runStart + amplitudeStepEdgeContextWindows + 1;
      rightIndex < runEnd - amplitudeStepEdgeContextWindows;
      rightIndex += 1
    ) {
      steps.push(
        amplitudeStepDecibels(windows[rightIndex - 1]!.amplitude, windows[rightIndex]!.amplitude),
      );
    }
    runStart = runEnd;
  }
  return steps;
}

function amplitudeStepDecibels(left: number, right: number) {
  /*
   * Active windows have a positive amplitude floor, but retain the clamp as a
   * local numerical invariant so a future detector cannot produce infinity
   * and silently poison a bounded histogram.
   */
  const safeLeft = Math.max(Number.EPSILON, left);
  const safeRight = Math.max(Number.EPSILON, right);
  return 20 * Math.abs(Math.log10(safeRight / safeLeft));
}

function measurePhaseContinuity(
  windows: readonly ToneWindow[],
  active: readonly boolean[],
  spanWindows: number,
  discontinuityThresholdRadians: number,
) {
  const steps: number[] = [];
  for (let index = spanWindows; index < windows.length; index += 1) {
    let entireSpanActive = true;
    for (let spanIndex = index - spanWindows; spanIndex <= index; spanIndex += 1) {
      if (!active[spanIndex]) {
        entireSpanActive = false;
        break;
      }
    }
    if (!entireSpanActive) continue;
    steps.push(
      wrapRadians(windows[index]!.phaseRadians - windows[index - spanWindows]!.phaseRadians),
    );
  }
  const medianStepRadians = median(steps);
  let discontinuityCount = 0;
  let maximumErrorRadians = 0;
  for (const step of steps) {
    const error = Math.abs(wrapRadians(step - medianStepRadians));
    maximumErrorRadians = Math.max(maximumErrorRadians, error);
    if (error > discontinuityThresholdRadians) {
      discontinuityCount += 1;
    }
  }
  return {
    discontinuityCount,
    maximumErrorRadians,
    medianStepRadians,
  };
}

function wrapRadians(value: number) {
  let wrapped = value % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped < -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

function coefficientOfVariation(values: readonly number[]) {
  if (values.length === 0) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((total, value) => total + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function median(values: readonly number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function validateOptions(options: AcousticToneAnalysisOptions) {
  validateAnalysisConfiguration(options);
  if (options.samples.length === 0) {
    throw new Error("The acoustic recording must contain PCM16 samples.");
  }
}

function validateAnalysisConfiguration(
  options: AcousticToneAnalysisOptions | AcousticToneArtifactAnalysisOptions,
) {
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error("The acoustic sample rate must be a positive integer.");
  }
  if (
    !Number.isFinite(options.frequencyHz) ||
    options.frequencyHz <= 0 ||
    options.frequencyHz >= options.sampleRateHz / 2
  ) {
    throw new Error("The acoustic tone frequency must be below Nyquist.");
  }
  if (!Number.isSafeInteger(options.expectedDurationMs) || options.expectedDurationMs <= 0) {
    throw new Error("The expected acoustic duration must be a positive integer.");
  }
  const windowDurationMs = options.windowDurationMs ?? defaultWindowDurationMs;
  if (!Number.isFinite(windowDurationMs) || windowDurationMs <= 0) {
    throw new Error("The acoustic analysis window duration must be positive.");
  }
  const minimumToneAmplitude = options.minimumToneAmplitude ?? defaultMinimumToneAmplitude;
  if (!Number.isFinite(minimumToneAmplitude) || minimumToneAmplitude < 0) {
    throw new Error("The minimum acoustic tone amplitude must be nonnegative.");
  }
  const minimumCoherence = options.minimumCoherence ?? defaultMinimumCoherence;
  if (!Number.isFinite(minimumCoherence) || minimumCoherence <= 0 || minimumCoherence > 1) {
    throw new Error("The minimum acoustic tone coherence must be in (0, 1].");
  }
  const phaseDiscontinuityThresholdRadians =
    options.phaseDiscontinuityThresholdRadians ?? defaultPhaseDiscontinuityThresholdRadians;
  if (
    !Number.isFinite(phaseDiscontinuityThresholdRadians) ||
    phaseDiscontinuityThresholdRadians <= 0 ||
    phaseDiscontinuityThresholdRadians > Math.PI
  ) {
    throw new Error("The acoustic phase-discontinuity threshold must be in (0, pi].");
  }
}

function formatMilliseconds(value: number) {
  return `${Number(value.toFixed(3))} ms`;
}

function formatRadians(value: number) {
  return `${Number(value.toFixed(6))} rad`;
}

function formatDecibels(value: number) {
  return `${Number(value.toFixed(3))} dB`;
}
