export enum AecDiagnosticTraceState {
  Idle = 0,
  Armed = 1,
  Capturing = 2,
  Ready = 3,
  Aborted = 4,
}

export enum AecDiagnosticPlane {
  Near = 1 << 0,
  Reference = 1 << 1,
  Playout = 1 << 2,
  Linear = 1 << 3,
  Clean = 1 << 4,
}

const traceMagic = 0x3154_4149;
const traceSchema = 1;
const metadataWords = 16;
const planeOrder = [
  ["near", AecDiagnosticPlane.Near],
  ["reference", AecDiagnosticPlane.Reference],
  ["playout", AecDiagnosticPlane.Playout],
  ["linear", AecDiagnosticPlane.Linear],
  ["clean", AecDiagnosticPlane.Clean],
] as const;

export interface AecDiagnosticTraceCapability {
  describe(): Promise<Uint8Array>;
  start(): Promise<number>;
  read(input: { sampleOffset: number; sampleCount: number }): Promise<Uint8Array>;
  release(): Promise<boolean>;
}

export interface AecDiagnosticTraceMetadata {
  abortedCaptures: number;
  availablePlanes: number;
  captureSamples: number;
  capturedSamples: number;
  completedCaptures: number;
  firstFrameSequence: number;
  frameSamples: number;
  generation: number;
  lastFrameSequence: number;
  maximumReadSamples: number;
  rejectedStarts: number;
  sampleRateHz: number;
  schema: number;
  startedCaptures: number;
  state: AecDiagnosticTraceState;
}

export interface AecDiagnosticTraceResult {
  metadata: AecDiagnosticTraceMetadata;
  planes: Partial<Record<(typeof planeOrder)[number][0], Uint8Array>>;
}

export function decodeAecDiagnosticTraceMetadata(bytes: Uint8Array): AecDiagnosticTraceMetadata {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== metadataWords * 4) {
    throw new Error(`AEC trace metadata must be exactly ${metadataWords * 4} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (index: number) => view.getUint32(index * 4, true);
  if (word(0) !== traceMagic) throw new Error("AEC trace metadata magic is invalid");
  if (word(1) !== traceSchema) {
    throw new Error(`Unsupported AEC trace schema ${word(1)}`);
  }
  const state = word(7);
  if (state > AecDiagnosticTraceState.Aborted) {
    throw new Error(`Unsupported AEC trace state ${state}`);
  }
  const availablePlanes = word(5);
  const required = AecDiagnosticPlane.Near | AecDiagnosticPlane.Clean;
  if ((availablePlanes & required) !== required || (availablePlanes & ~0x1f) !== 0) {
    throw new Error(`Invalid AEC trace plane mask ${availablePlanes}`);
  }
  const result = {
    abortedCaptures: word(14),
    availablePlanes,
    captureSamples: word(4),
    capturedSamples: word(9),
    completedCaptures: word(13),
    firstFrameSequence: word(10),
    frameSamples: word(3),
    generation: word(8),
    lastFrameSequence: word(11),
    maximumReadSamples: word(6),
    rejectedStarts: word(15),
    sampleRateHz: word(2),
    schema: word(1),
    startedCaptures: word(12),
    state: state as AecDiagnosticTraceState,
  } satisfies AecDiagnosticTraceMetadata;
  if (
    result.sampleRateHz === 0 ||
    result.frameSamples === 0 ||
    result.captureSamples === 0 ||
    result.maximumReadSamples === 0 ||
    result.captureSamples % result.frameSamples !== 0 ||
    result.capturedSamples > result.captureSamples
  ) {
    throw new Error("AEC trace metadata contains an invalid bounded geometry");
  }
  return result;
}

export async function startAecDiagnosticTrace(capability: AecDiagnosticTraceCapability) {
  const generation = await capability.start();
  if (!Number.isInteger(generation) || generation <= 0 || generation > 0xffff_ffff) {
    throw new Error(`AEC trace returned invalid generation ${generation}`);
  }
  return generation;
}

export async function retrieveAecDiagnosticTrace(
  capability: AecDiagnosticTraceCapability,
  options: {
    expectedGeneration: number;
    pollIntervalMs?: number;
    timeoutMs: number;
  },
): Promise<AecDiagnosticTraceResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  if (
    !Number.isInteger(options.expectedGeneration) ||
    options.expectedGeneration <= 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0
  ) {
    throw new Error("AEC trace retrieval requires bounded generation, timeout, and poll values");
  }

  const deadline = Date.now() + options.timeoutMs;
  let metadata: AecDiagnosticTraceMetadata;
  for (;;) {
    metadata = decodeAecDiagnosticTraceMetadata(await capability.describe());
    if (metadata.generation !== options.expectedGeneration) {
      throw new Error(
        `AEC trace generation changed from ${options.expectedGeneration} to ${metadata.generation}`,
      );
    }
    if (
      metadata.state === AecDiagnosticTraceState.Ready ||
      metadata.state === AecDiagnosticTraceState.Aborted
    ) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `AEC trace generation ${options.expectedGeneration} timed out in state ${metadata.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  try {
    if (metadata.state === AecDiagnosticTraceState.Aborted) {
      throw new Error(
        `AEC trace generation ${metadata.generation} aborted after ${metadata.capturedSamples} samples`,
      );
    }
    if (metadata.capturedSamples !== metadata.captureSamples) {
      throw new Error(
        `AEC trace READY generation retained ${metadata.capturedSamples}/${metadata.captureSamples} samples`,
      );
    }

    const planes: AecDiagnosticTraceResult["planes"] = {};
    for (const [name, bit] of planeOrder) {
      if ((metadata.availablePlanes & bit) !== 0) {
        planes[name] = new Uint8Array(metadata.captureSamples * 2);
      }
    }
    for (
      let sampleOffset = 0;
      sampleOffset < metadata.captureSamples;
      sampleOffset += metadata.maximumReadSamples
    ) {
      const sampleCount = Math.min(
        metadata.maximumReadSamples,
        metadata.captureSamples - sampleOffset,
      );
      const bytes = await capability.read({ sampleOffset, sampleCount });
      const expectedBytes = sampleCount * planeOrder.length * 2;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedBytes) {
        throw new Error(
          `AEC trace read at ${sampleOffset} has byte length ${bytes?.byteLength ?? "unknown"}; expected ${expectedBytes}`,
        );
      }
      for (let planeIndex = 0; planeIndex < planeOrder.length; planeIndex++) {
        const [name] = planeOrder[planeIndex]!;
        const destination = planes[name];
        if (destination === undefined) continue;
        const planeStart = planeIndex * sampleCount * 2;
        destination.set(bytes.subarray(planeStart, planeStart + sampleCount * 2), sampleOffset * 2);
      }
    }
    return { metadata, planes };
  } finally {
    if (!(await capability.release())) {
      throw new Error(`AEC trace generation ${metadata.generation} refused release`);
    }
  }
}
