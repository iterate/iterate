import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  connectItxReady,
  type Stream,
  type StreamRuntimeDebugState,
  type ItxWebSocketMessage,
} from "../packages/iterate/src/node.ts";
import { disposeIgnoredRpcResult } from "../packages/iterate/src/sdk/capnweb/live-state/retain.ts";

const projectId = "prj_d5139a9e1afd4a9688d9d006e5d6f6f6";
type ReproMode =
  | "defaults-vs-none"
  | "read-vs-append"
  | "empty-append-v-ephemeral"
  | "correlated-append";

function reproMode(): ReproMode {
  const index = process.argv.indexOf("--mode");
  const value = index === -1 ? "defaults-vs-none" : process.argv[index + 1];
  if (
    value === "defaults-vs-none" ||
    value === "read-vs-append" ||
    value === "empty-append-v-ephemeral" ||
    value === "correlated-append"
  )
    return value;
  throw new Error(
    "use --mode defaults-vs-none, read-vs-append, empty-append-v-ephemeral, or correlated-append",
  );
}

const mode = reproMode();
const baseUrl = requiredEnvironment("APP_CONFIG_BASE_URL");
const secret = requiredEnvironment("APP_CONFIG_ADMIN_API_SECRET");
const runId = `defaults-vs-none-${Date.now()}-${randomUUID().slice(0, 8)}`;
const streamPath = {
  defaults: `/repros/${runId}/defaults`,
  none: `/repros/${runId}/none`,
} as const;

// Keep this a matched, bounded two-minute probe: 50 append pairs per second.
const durationMs = 120_000;
const periodMs = 20;
const maxInFlight = 512;
const pendingTimeoutMs = 6_000;
const multiSecondFailureMs = 2_000;
const rpcTimeoutMs = 15_000;
const drainTimeoutMs = pendingTimeoutMs + 5_000;

type Arm = keyof typeof streamPath;
type Sample = {
  arm: Arm;
  index: number;
  startedAtMs: number;
  endedAtMs?: number;
  latencyMs?: number;
  error?: string;
};
type Summary = {
  count: number;
  settled: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  multiSecond: number;
};
type Artifact = {
  runId: string;
  projectId: string;
  streamPath: typeof streamPath;
  config: {
    durationMs: number;
    periodMs: number;
    maxInFlight: number;
    pendingTimeoutMs: number;
    multiSecondFailureMs: number;
    rpcTimeoutMs: number;
    drainTimeoutMs: number;
  };
  startedAtMs: number;
  effectiveOutboundSubscriptionCountBefore?: Record<Arm, number>;
  frameStartedAtMs?: number;
  frameEndedAtMs?: number;
  sentPerArm?: number;
  stopReason?: string;
  markerOffset?: Partial<Record<Arm, number>>;
  runtimeAfter?: Record<Arm, StreamRuntimeDebugState>;
  effectiveOutboundSubscriptionCountAfter?: Record<Arm, number>;
  fatalError?: string;
  endedAtMs?: number;
  samples?: Sample[];
  summary?: Record<Arm, Summary>;
};

type PendingAppend = { sample: Sample; settled: Promise<void> };

const samples: Sample[] = [];
const pending = new Set<PendingAppend>();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Bound a single RPC wait while retaining ownership of a late result. An RPC
 * cannot be cancelled from here; late fulfillment is still released.
 */
function within<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} exceeded ${rpcTimeoutMs}ms`));
    }, rpcTimeoutMs);
    void operation.then(
      (result) => {
        if (timedOut) {
          disposeIgnoredRpcResult(result);
          return;
        }
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        if (timedOut) return;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function readRpcResult<T>(operation: Promise<T>, label: string): Promise<T> {
  const result = await within(operation, label);
  try {
    return structuredClone(result);
  } finally {
    disposeIgnoredRpcResult(result);
  }
}

async function discardRpcResult(operation: Promise<unknown>, label: string): Promise<void> {
  disposeIgnoredRpcResult(await within(operation, label));
}

function outboundSubscriptionCount(runtime: StreamRuntimeDebugState): number {
  return Object.keys(runtime.coreProcessorState.subscriptions.outbound.byName).length;
}

function launch(arm: Arm, index: number, stream: Stream): void {
  const sample: Sample = { arm, index, startedAtMs: Date.now() };
  samples.push(sample);
  const entry = { sample, settled: Promise.resolve() } as PendingAppend;
  entry.settled = discardRpcResult(
    stream.append({
      type: "events.iterate.com/repro/ephemeral-frame",
      ephemeral: true,
      payload: { fixed: "frame" },
    }),
    `${arm} frame ${index}`,
  )
    .catch((error: unknown) => {
      sample.error = errorMessage(error);
    })
    .finally(() => {
      sample.endedAtMs = Date.now();
      sample.latencyMs = sample.endedAtMs - sample.startedAtMs;
      pending.delete(entry);
    });
  pending.add(entry);
}

function oldestPending(): PendingAppend | undefined {
  let oldest: PendingAppend | undefined;
  for (const entry of pending) {
    if (!oldest || entry.sample.startedAtMs < oldest.sample.startedAtMs) oldest = entry;
  }
  return oldest;
}

async function drainPending(): Promise<number> {
  const deadline = Date.now() + drainTimeoutMs;
  while (pending.size > 0 && Date.now() < deadline) await sleep(10);
  return pending.size;
}

async function appendMarker(stream: Stream, arm: Arm): Promise<number> {
  const events = await readRpcResult(
    stream.append({
      type: "events.iterate.com/repro/marker",
      idempotencyKey: `${runId}:${arm}:marker`,
      payload: { runId, arm },
    }),
    `${arm} durable marker`,
  );
  const marker = events.at(0);
  if (!marker) throw new Error(`${arm} marker append returned no event`);
  return marker.offset;
}

function summarise(arm: Arm): Summary {
  const armSamples = samples.filter((sample) => sample.arm === arm);
  const latencies = armSamples
    .flatMap((sample) => (sample.latencyMs === undefined ? [] : [sample.latencyMs]))
    .sort((left, right) => left - right);
  const percentile = (quantile: number): number | null =>
    latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) * quantile)]!;
  return {
    count: armSamples.length,
    settled: latencies.length,
    errors: armSamples.filter((sample) => sample.error).length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: latencies.at(-1) ?? null,
    multiSecond: armSamples.filter((sample) => (sample.latencyMs ?? 0) >= multiSecondFailureMs)
      .length,
  };
}

async function main(): Promise<void> {
  const artifact: Artifact = {
    runId,
    projectId,
    streamPath,
    config: {
      durationMs,
      periodMs,
      maxInFlight,
      pendingTimeoutMs,
      multiSecondFailureMs,
      rpcTimeoutMs,
      drainTimeoutMs,
    },
    startedAtMs: Date.now(),
  };

  try {
    using setup = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using defaultsClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using noneClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    const defaultsSetup = setup.streams.get(streamPath.defaults);
    const noneSetup = setup.streams.get(streamPath.none);
    const defaults = defaultsClient.streams.get(streamPath.defaults);
    const none = noneClient.streams.get(streamPath.none);

    await discardRpcResult(
      defaultsSetup.append({
        type: "events.iterate.com/repro/setup",
        idempotencyKey: `${runId}:defaults:setup`,
        payload: { runId },
      }),
      "defaults setup",
    );
    await discardRpcResult(
      noneSetup.append(
        {
          type: "events.iterate.com/stream/subscription-removed",
          payload: { name: "project-worker", reason: "requested" },
        },
        {
          type: "events.iterate.com/stream/subscription-removed",
          payload: { name: "iterate-platform-posthog", reason: "requested" },
        },
      ),
      "none subscription removal",
    );

    await sleep(1_000);
    const runtimeBefore = {
      defaults: await readRpcResult(defaultsSetup.runtimeState(), "defaults runtime before"),
      none: await readRpcResult(noneSetup.runtimeState(), "none runtime before"),
    };
    artifact.effectiveOutboundSubscriptionCountBefore = {
      defaults: outboundSubscriptionCount(runtimeBefore.defaults),
      none: outboundSubscriptionCount(runtimeBefore.none),
    };
    if (
      artifact.effectiveOutboundSubscriptionCountBefore.defaults !== 2 ||
      artifact.effectiveOutboundSubscriptionCountBefore.none !== 0
    ) {
      throw new Error(
        `unexpected effective configs defaults=${artifact.effectiveOutboundSubscriptionCountBefore.defaults} none=${artifact.effectiveOutboundSubscriptionCountBefore.none}`,
      );
    }

    const startedAtMs = Date.now();
    let sentPerArm = 0;
    let stopReason: string | undefined;
    while (Date.now() - startedAtMs < durationMs) {
      const oldest = oldestPending();
      if (oldest && Date.now() - oldest.sample.startedAtMs > pendingTimeoutMs) {
        stopReason = `pending append exceeded ${pendingTimeoutMs}ms`;
        break;
      }
      if (pending.size + 2 > maxInFlight) {
        stopReason = `in-flight bound ${maxInFlight} reached`;
        break;
      }
      launch("defaults", sentPerArm, defaults);
      launch("none", sentPerArm, none);
      sentPerArm += 1;
      const nextDueAtMs = startedAtMs + sentPerArm * periodMs;
      await sleep(Math.max(0, nextDueAtMs - Date.now()));
    }

    const unresolved = await drainPending();
    if (unresolved > 0) stopReason ??= `drain left ${unresolved} unresolved append(s)`;
    artifact.frameStartedAtMs = startedAtMs;
    artifact.frameEndedAtMs = Date.now();
    artifact.sentPerArm = sentPerArm;
    artifact.stopReason = stopReason;

    artifact.markerOffset = { defaults: await appendMarker(defaults, "defaults") };
    await sleep(3_000);
    artifact.markerOffset.none = await appendMarker(none, "none");
    await sleep(1_000);
    artifact.runtimeAfter = {
      defaults: await readRpcResult(defaultsSetup.runtimeState(), "defaults runtime after"),
      none: await readRpcResult(noneSetup.runtimeState(), "none runtime after"),
    };
    artifact.effectiveOutboundSubscriptionCountAfter = {
      defaults: outboundSubscriptionCount(artifact.runtimeAfter.defaults),
      none: outboundSubscriptionCount(artifact.runtimeAfter.none),
    };
  } catch (error) {
    artifact.fatalError = errorMessage(error);
  } finally {
    artifact.endedAtMs = Date.now();
    artifact.samples = samples;
    artifact.summary = { defaults: summarise("defaults"), none: summarise("none") };
    const outputPath = `/tmp/futurehomes-${runId}.json`;
    await writeFile(outputPath, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({ outputPath, ...artifact }, null, 2));
  }
}

type ReadAppendArm = "read" | "append";
type ReadAppendSample = Omit<Sample, "arm"> & { arm: ReadAppendArm };
type ReadAppendArtifact = Omit<
  Artifact,
  | "streamPath"
  | "effectiveOutboundSubscriptionCountBefore"
  | "runtimeAfter"
  | "effectiveOutboundSubscriptionCountAfter"
  | "samples"
  | "summary"
  | "markerOffset"
> & {
  mode: "read-vs-append";
  streamPath: Record<ReadAppendArm, string>;
  effectiveOutboundSubscriptionCountBefore?: Record<ReadAppendArm, number>;
  runtimeAfter?: Record<ReadAppendArm, StreamRuntimeDebugState>;
  effectiveOutboundSubscriptionCountAfter?: Record<ReadAppendArm, number>;
  prewarmPage?: Record<
    ReadAppendArm,
    { streamId: string; streamMaxOffset: number; eventCount: number }
  >;
  samples?: ReadAppendSample[];
  summary?: Record<ReadAppendArm, Summary>;
};

async function mainReadVsAppend(): Promise<void> {
  const readAppendRunId = `read-vs-append-10m-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const paths: Record<ReadAppendArm, string> = {
    read: `/repros/${readAppendRunId}/read`,
    append: `/repros/${readAppendRunId}/append`,
  };
  const readAppendSamples: ReadAppendSample[] = [];
  const readAppendPending = new Set<{ sample: ReadAppendSample; settled: Promise<void> }>();
  const readAppendDurationMs = 600_000;
  const artifact: ReadAppendArtifact = {
    mode: "read-vs-append",
    runId: readAppendRunId,
    projectId,
    streamPath: paths,
    config: {
      durationMs: readAppendDurationMs,
      periodMs,
      maxInFlight,
      pendingTimeoutMs,
      multiSecondFailureMs,
      rpcTimeoutMs,
      drainTimeoutMs,
    },
    startedAtMs: Date.now(),
  };
  const fixedEmptyPage = { beforeOffset: 0, limit: 1 } as const;
  const removalEvents = [
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "project-worker", reason: "requested" },
    },
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "iterate-platform-posthog", reason: "requested" },
    },
  ] as const;
  const summariseReadAppend = (arm: ReadAppendArm): Summary => {
    const armSamples = readAppendSamples.filter((sample) => sample.arm === arm);
    const latencies = armSamples
      .flatMap((sample) => (sample.latencyMs === undefined ? [] : [sample.latencyMs]))
      .sort((a, b) => a - b);
    const percentile = (quantile: number) =>
      latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) * quantile)]!;
    return {
      count: armSamples.length,
      settled: latencies.length,
      errors: armSamples.filter((sample) => sample.error).length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: latencies.at(-1) ?? null,
      multiSecond: armSamples.filter((sample) => (sample.latencyMs ?? 0) >= multiSecondFailureMs)
        .length,
    };
  };
  const launchReadAppend = (arm: ReadAppendArm, index: number, stream: Stream): void => {
    const sample: ReadAppendSample = { arm, index, startedAtMs: Date.now() };
    readAppendSamples.push(sample);
    const entry = { sample, settled: Promise.resolve() } as {
      sample: ReadAppendSample;
      settled: Promise<void>;
    };
    const operation =
      arm === "read"
        ? readRpcResult(stream.getEventPage(fixedEmptyPage), `${arm} page ${index}`).then(
            () => undefined,
          )
        : discardRpcResult(
            stream.append({
              type: "events.iterate.com/repro/ephemeral-frame",
              ephemeral: true,
              payload: { fixed: "frame" },
            }),
            `${arm} frame ${index}`,
          );
    entry.settled = operation
      .catch((error: unknown) => {
        sample.error = errorMessage(error);
      })
      .finally(() => {
        sample.endedAtMs = Date.now();
        sample.latencyMs = sample.endedAtMs - sample.startedAtMs;
        readAppendPending.delete(entry);
      });
    readAppendPending.add(entry);
  };
  try {
    // Independent sessions prevent either arm's native RPC connection from becoming the other's queue.
    using setup = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using readClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using appendClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    const setupStreams = {
      read: setup.streams.get(paths.read),
      append: setup.streams.get(paths.append),
    };
    const streams = {
      read: readClient.streams.get(paths.read),
      append: appendClient.streams.get(paths.append),
    };
    for (const arm of ["read", "append"] as const)
      await discardRpcResult(
        setupStreams[arm].append(...removalEvents),
        `${arm} subscription removal`,
      );
    await sleep(1_000);
    const before = {
      read: await readRpcResult(setupStreams.read.runtimeState(), "read runtime before"),
      append: await readRpcResult(setupStreams.append.runtimeState(), "append runtime before"),
    };
    artifact.effectiveOutboundSubscriptionCountBefore = {
      read: outboundSubscriptionCount(before.read),
      append: outboundSubscriptionCount(before.append),
    };
    if (
      artifact.effectiveOutboundSubscriptionCountBefore.read !== 0 ||
      artifact.effectiveOutboundSubscriptionCountBefore.append !== 0
    )
      throw new Error(
        `unexpected effective configs read=${artifact.effectiveOutboundSubscriptionCountBefore.read} append=${artifact.effectiveOutboundSubscriptionCountBefore.append}`,
      );
    const readPrewarm = await readRpcResult(
      streams.read.getEventPage(fixedEmptyPage),
      "read fixed-empty prewarm",
    );
    const appendPrewarm = await readRpcResult(
      streams.append.getEventPage(fixedEmptyPage),
      "append fixed-empty prewarm",
    );
    artifact.prewarmPage = {
      read: {
        streamId: readPrewarm.streamId,
        streamMaxOffset: readPrewarm.streamMaxOffset,
        eventCount: readPrewarm.events.length,
      },
      append: {
        streamId: appendPrewarm.streamId,
        streamMaxOffset: appendPrewarm.streamMaxOffset,
        eventCount: appendPrewarm.events.length,
      },
    };
    const startedAtMs = Date.now();
    let sentPerArm = 0;
    let stopReason: string | undefined;
    while (Date.now() - startedAtMs < readAppendDurationMs) {
      let oldest: { sample: ReadAppendSample } | undefined;
      for (const entry of readAppendPending)
        if (!oldest || entry.sample.startedAtMs < oldest.sample.startedAtMs) oldest = entry;
      if (oldest && Date.now() - oldest.sample.startedAtMs > pendingTimeoutMs) {
        stopReason = `pending RPC exceeded ${pendingTimeoutMs}ms`;
        break;
      }
      if (readAppendPending.size + 2 > maxInFlight) {
        stopReason = `in-flight bound ${maxInFlight} reached`;
        break;
      }
      launchReadAppend("read", sentPerArm, streams.read);
      launchReadAppend("append", sentPerArm, streams.append);
      sentPerArm += 1;
      await sleep(Math.max(0, startedAtMs + sentPerArm * periodMs - Date.now()));
    }
    const drainDeadline = Date.now() + drainTimeoutMs;
    while (readAppendPending.size > 0 && Date.now() < drainDeadline) await sleep(10);
    if (readAppendPending.size > 0)
      stopReason ??= `drain left ${readAppendPending.size} unresolved RPC(s)`;
    artifact.frameStartedAtMs = startedAtMs;
    artifact.frameEndedAtMs = Date.now();
    artifact.sentPerArm = sentPerArm;
    artifact.stopReason = stopReason;
    artifact.runtimeAfter = {
      read: await readRpcResult(setupStreams.read.runtimeState(), "read runtime after"),
      append: await readRpcResult(setupStreams.append.runtimeState(), "append runtime after"),
    };
    artifact.effectiveOutboundSubscriptionCountAfter = {
      read: outboundSubscriptionCount(artifact.runtimeAfter.read),
      append: outboundSubscriptionCount(artifact.runtimeAfter.append),
    };
  } catch (error) {
    artifact.fatalError = errorMessage(error);
  } finally {
    artifact.endedAtMs = Date.now();
    artifact.samples = readAppendSamples;
    artifact.summary = { read: summariseReadAppend("read"), append: summariseReadAppend("append") };
    const outputPath = `/tmp/futurehomes-${readAppendRunId}.json`;
    await writeFile(outputPath, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({ outputPath, ...artifact }, null, 2));
  }
}

type EmptyAppendArm = "empty" | "append";
type EmptyAppendSample = Omit<Sample, "arm"> & { arm: EmptyAppendArm };
type EmptyAppendArtifact = Omit<
  Artifact,
  | "streamPath"
  | "effectiveOutboundSubscriptionCountBefore"
  | "runtimeAfter"
  | "effectiveOutboundSubscriptionCountAfter"
  | "samples"
  | "summary"
  | "markerOffset"
> & {
  mode: "empty-append-v-ephemeral";
  streamPath: Record<EmptyAppendArm, string>;
  effectiveOutboundSubscriptionCountBefore?: Record<EmptyAppendArm, number>;
  runtimeAfter?: Record<EmptyAppendArm, StreamRuntimeDebugState>;
  effectiveOutboundSubscriptionCountAfter?: Record<EmptyAppendArm, number>;
  prewarmOperation?: Record<EmptyAppendArm, "append-empty">;
  samples?: EmptyAppendSample[];
  summary?: Record<EmptyAppendArm, Summary>;
};

async function mainEmptyAppendVsEphemeral(): Promise<void> {
  const readAppendRunId = `empty-append-v-ephemeral-10m-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const paths: Record<EmptyAppendArm, string> = {
    empty: `/repros/${readAppendRunId}/empty`,
    append: `/repros/${readAppendRunId}/append`,
  };
  const readAppendSamples: EmptyAppendSample[] = [];
  const readAppendPending = new Set<{ sample: EmptyAppendSample; settled: Promise<void> }>();
  const readAppendDurationMs = 600_000;
  const artifact: EmptyAppendArtifact = {
    mode: "empty-append-v-ephemeral",
    runId: readAppendRunId,
    projectId,
    streamPath: paths,
    config: {
      durationMs: readAppendDurationMs,
      periodMs,
      maxInFlight,
      pendingTimeoutMs,
      multiSecondFailureMs,
      rpcTimeoutMs,
      drainTimeoutMs,
    },
    startedAtMs: Date.now(),
  };
  const removalEvents = [
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "project-worker", reason: "requested" },
    },
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "iterate-platform-posthog", reason: "requested" },
    },
  ] as const;
  const summariseEmptyAppend = (arm: EmptyAppendArm): Summary => {
    const armSamples = readAppendSamples.filter((sample) => sample.arm === arm);
    const latencies = armSamples
      .flatMap((sample) => (sample.latencyMs === undefined ? [] : [sample.latencyMs]))
      .sort((a, b) => a - b);
    const percentile = (quantile: number) =>
      latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) * quantile)]!;
    return {
      count: armSamples.length,
      settled: latencies.length,
      errors: armSamples.filter((sample) => sample.error).length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: latencies.at(-1) ?? null,
      multiSecond: armSamples.filter((sample) => (sample.latencyMs ?? 0) >= multiSecondFailureMs)
        .length,
    };
  };
  const launchEmptyAppend = (arm: EmptyAppendArm, index: number, stream: Stream): void => {
    const sample: EmptyAppendSample = { arm, index, startedAtMs: Date.now() };
    readAppendSamples.push(sample);
    const entry = { sample, settled: Promise.resolve() } as {
      sample: EmptyAppendSample;
      settled: Promise<void>;
    };
    const operation =
      arm === "empty"
        ? discardRpcResult(stream.append(), `${arm} append ${index}`)
        : discardRpcResult(
            stream.append({
              type: "events.iterate.com/repro/ephemeral-frame",
              ephemeral: true,
              payload: { fixed: "frame" },
            }),
            `${arm} frame ${index}`,
          );
    entry.settled = operation
      .catch((error: unknown) => {
        sample.error = errorMessage(error);
      })
      .finally(() => {
        sample.endedAtMs = Date.now();
        sample.latencyMs = sample.endedAtMs - sample.startedAtMs;
        readAppendPending.delete(entry);
      });
    readAppendPending.add(entry);
  };
  try {
    // Independent sessions prevent either arm's native RPC connection from becoming the other's queue.
    using setup = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using readClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    using appendClient = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    const setupStreams = {
      empty: setup.streams.get(paths.empty),
      append: setup.streams.get(paths.append),
    };
    const streams = {
      empty: readClient.streams.get(paths.empty),
      append: appendClient.streams.get(paths.append),
    };
    for (const arm of ["empty", "append"] as const)
      await discardRpcResult(
        setupStreams[arm].append(...removalEvents),
        `${arm} subscription removal`,
      );
    await sleep(1_000);
    const before = {
      empty: await readRpcResult(setupStreams.empty.runtimeState(), "empty runtime before"),
      append: await readRpcResult(setupStreams.append.runtimeState(), "append runtime before"),
    };
    artifact.effectiveOutboundSubscriptionCountBefore = {
      empty: outboundSubscriptionCount(before.empty),
      append: outboundSubscriptionCount(before.append),
    };
    if (
      artifact.effectiveOutboundSubscriptionCountBefore.empty !== 0 ||
      artifact.effectiveOutboundSubscriptionCountBefore.append !== 0
    )
      throw new Error(
        `unexpected effective configs empty=${artifact.effectiveOutboundSubscriptionCountBefore.empty} append=${artifact.effectiveOutboundSubscriptionCountBefore.append}`,
      );
    await discardRpcResult(streams.empty.append(), "empty append prewarm");
    await discardRpcResult(streams.append.append(), "append empty prewarm");
    artifact.prewarmOperation = { empty: "append-empty", append: "append-empty" };
    const startedAtMs = Date.now();
    let sentPerArm = 0;
    let stopReason: string | undefined;
    while (Date.now() - startedAtMs < readAppendDurationMs) {
      let oldest: { sample: EmptyAppendSample } | undefined;
      for (const entry of readAppendPending)
        if (!oldest || entry.sample.startedAtMs < oldest.sample.startedAtMs) oldest = entry;
      if (oldest && Date.now() - oldest.sample.startedAtMs > pendingTimeoutMs) {
        stopReason = `pending RPC exceeded ${pendingTimeoutMs}ms`;
        break;
      }
      if (readAppendPending.size + 2 > maxInFlight) {
        stopReason = `in-flight bound ${maxInFlight} reached`;
        break;
      }
      launchEmptyAppend("empty", sentPerArm, streams.empty);
      launchEmptyAppend("append", sentPerArm, streams.append);
      sentPerArm += 1;
      await sleep(Math.max(0, startedAtMs + sentPerArm * periodMs - Date.now()));
    }
    const drainDeadline = Date.now() + drainTimeoutMs;
    while (readAppendPending.size > 0 && Date.now() < drainDeadline) await sleep(10);
    if (readAppendPending.size > 0)
      stopReason ??= `drain left ${readAppendPending.size} unresolved RPC(s)`;
    artifact.frameStartedAtMs = startedAtMs;
    artifact.frameEndedAtMs = Date.now();
    artifact.sentPerArm = sentPerArm;
    artifact.stopReason = stopReason;
    artifact.runtimeAfter = {
      empty: await readRpcResult(setupStreams.empty.runtimeState(), "empty runtime after"),
      append: await readRpcResult(setupStreams.append.runtimeState(), "append runtime after"),
    };
    artifact.effectiveOutboundSubscriptionCountAfter = {
      empty: outboundSubscriptionCount(artifact.runtimeAfter.empty),
      append: outboundSubscriptionCount(artifact.runtimeAfter.append),
    };
  } catch (error) {
    artifact.fatalError = errorMessage(error);
  } finally {
    artifact.endedAtMs = Date.now();
    artifact.samples = readAppendSamples;
    artifact.summary = {
      empty: summariseEmptyAppend("empty"),
      append: summariseEmptyAppend("append"),
    };
    const outputPath = `/tmp/futurehomes-${readAppendRunId}.json`;
    await writeFile(outputPath, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({ outputPath, ...artifact }, null, 2));
  }
}

type CorrelatedSample = {
  index: number;
  probeId: string;
  startedAtMs: number;
  settledAtMs?: number;
  latencyMs?: number;
  outboundFrames: WireFrameTime[];
  inboundFrames: WireFrameTime[];
  stagesMs?: {
    submitToOutbound: number;
    outboundToInbound: number;
    inboundToSettle: number;
  };
  error?: string;
};

type WireFrameTime = {
  /** Same wall clock as submit and promise settlement; use this for stages. */
  observedAtMs: number;
  /** Socket-local time, retained only for raw transport ordering evidence. */
  relativeMs: number;
};

type CorrelatedArtifact = {
  mode: "correlated-append";
  runId: string;
  projectId: string;
  streamPath: string;
  /** Caller-supplied W3C trace ID for exact Cloudflare trace retrieval. */
  traceId: string;
  config: {
    durationMs: number;
    periodMs: number;
    maxInFlight: number;
    pendingTimeoutMs: number;
    rpcTimeoutMs: number;
    drainTimeoutMs: number;
  };
  startedAtMs: number;
  frameStartedAtMs?: number;
  frameEndedAtMs?: number;
  sent?: number;
  stopReason?: string;
  effectiveOutboundSubscriptionCountBefore?: number;
  effectiveOutboundSubscriptionCountAfter?: number;
  fatalError?: string;
  endedAtMs?: number;
  samples: CorrelatedSample[];
  correlationErrors: string[];
  /** Set only if the bounded decoder walk reached a safety limit. */
  frameScanLimitHit?: CorrelatedFrameScanLimitHit;
  socketCloses: CorrelatedSocketClose[];
  passed?: boolean;
};

type CorrelatedFrameScanLimitHit = {
  direction: "in" | "out";
  observedAtMs: number;
  visitedNodes: number;
  maxDepth: number;
  nodeLimitReached: boolean;
  depthLimitReached: boolean;
};

type CorrelatedSocketClose = {
  observedAtMs: number;
  code: number;
  reason: string;
  phase: "setup" | "dispatch" | "drain" | "cleanup";
};

const MAX_FRAME_SCAN_DEPTH = 32;
const MAX_FRAME_SCAN_NODES = 10_000;
const REPRO_PROBE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function requestedCorrelatedDurationMs(): number {
  const index = process.argv.indexOf("--duration-ms");
  if (index === -1) return 600_000;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000)
    throw new Error("--duration-ms must be an integer from 1000 through 600000");
  return value;
}

/** Find known probe IDs without reading getters or walking an unbounded decoded frame. */
function probeIdsInFrame(value: unknown, knownProbeIds: Pick<ReadonlySet<string>, "has">) {
  const found = new Set<string>();
  let visited = 0;
  let maxDepth = 0;
  let nodeLimitReached = false;
  let depthLimitReached = false;
  const visit = (candidate: unknown, depth: number): void => {
    if (visited >= MAX_FRAME_SCAN_NODES) {
      nodeLimitReached = true;
      return;
    }
    if (depth > MAX_FRAME_SCAN_DEPTH) {
      depthLimitReached = true;
      return;
    }
    visited += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (typeof candidate === "string") {
      if (knownProbeIds.has(candidate)) found.add(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    for (const key of Object.keys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor?.get === undefined && "value" in (descriptor ?? {}))
        visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  return { found, visited, maxDepth, nodeLimitReached, depthLimitReached };
}

async function mainCorrelatedAppend(): Promise<void> {
  const durationMs = requestedCorrelatedDurationMs();
  const correlatedRunId = `correlated-append-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const path = `/repros/${correlatedRunId}/correlated`;
  const traceId = randomUUID().replaceAll("-", "");
  const traceParentId = randomUUID().replaceAll("-", "").slice(0, 16);
  const samples: CorrelatedSample[] = [];
  const byProbeId = new Map<string, CorrelatedSample>();
  const pending = new Set<{ sample: CorrelatedSample; settled: Promise<void> }>();
  let phase: CorrelatedSocketClose["phase"] = "setup";
  let firstRpcFailure: string | undefined;
  const artifact: CorrelatedArtifact = {
    mode: "correlated-append",
    runId: correlatedRunId,
    projectId,
    streamPath: path,
    traceId,
    config: { durationMs, periodMs, maxInFlight, pendingTimeoutMs, rpcTimeoutMs, drainTimeoutMs },
    startedAtMs: Date.now(),
    samples,
    correlationErrors: [],
    socketCloses: [],
  };
  const onWebSocketMessage = (message: ItxWebSocketMessage) => {
    const [relativeMs, direction, data] = message;
    // This must be first: frame observation, submit, and settlement share
    // Date.now(). The supplied relative time has a different socket epoch.
    const observedAtMs = Date.now();
    const scan = probeIdsInFrame(data, byProbeId);
    if (
      artifact.frameScanLimitHit === undefined &&
      (scan.nodeLimitReached || scan.depthLimitReached)
    )
      artifact.frameScanLimitHit = {
        direction,
        observedAtMs,
        visitedNodes: scan.visited,
        maxDepth: scan.maxDepth,
        nodeLimitReached: scan.nodeLimitReached,
        depthLimitReached: scan.depthLimitReached,
      };
    for (const probeId of scan.found) {
      const sample = byProbeId.get(probeId);
      if (sample === undefined) continue;
      (direction === "out" ? sample.outboundFrames : sample.inboundFrames).push({
        observedAtMs,
        relativeMs,
      });
    }
  };
  const removalEvents = [
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "project-worker", reason: "requested" },
    },
    {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "iterate-platform-posthog", reason: "requested" },
    },
  ] as const;
  let disposeClient: (() => void) | undefined;
  try {
    using setup = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
    });
    const client = await connectItxReady({
      auth: { type: "admin-secret", secret },
      baseUrl,
      projectId,
      // One trace per bounded repro run makes the smoke's full span tree and
      // any later tail query exact without putting trace details in payloads.
      headers: { traceparent: `00-${traceId}-${traceParentId}-01` },
      onWebSocketMessage,
      onWebSocketClose: ({ code, reason }) => {
        artifact.socketCloses.push({ observedAtMs: Date.now(), code, reason, phase });
      },
    });
    disposeClient = () => client[Symbol.dispose]?.();
    const setupStream = setup.streams.get(path);
    const stream = client.streams.get(path);
    await discardRpcResult(setupStream.append(...removalEvents), "correlated subscription removal");
    await sleep(1_000);
    artifact.effectiveOutboundSubscriptionCountBefore = outboundSubscriptionCount(
      await readRpcResult(setupStream.runtimeState(), "correlated runtime before"),
    );
    if (artifact.effectiveOutboundSubscriptionCountBefore !== 0)
      throw new Error(
        `unexpected correlated outbound config=${artifact.effectiveOutboundSubscriptionCountBefore}`,
      );
    await discardRpcResult(stream.append(), "correlated empty append prewarm");
    const startedAtMs = Date.now();
    phase = "dispatch";
    let sent = 0;
    while (Date.now() - startedAtMs < durationMs) {
      if (firstRpcFailure !== undefined) {
        artifact.stopReason = `first RPC failure: ${firstRpcFailure}`;
        break;
      }
      let oldest: { sample: CorrelatedSample } | undefined;
      for (const entry of pending)
        if (!oldest || entry.sample.startedAtMs < oldest.sample.startedAtMs) oldest = entry;
      if (oldest && Date.now() - oldest.sample.startedAtMs > pendingTimeoutMs) {
        artifact.stopReason = `pending RPC exceeded ${pendingTimeoutMs}ms`;
        break;
      }
      if (pending.size + 1 > maxInFlight) {
        artifact.stopReason = `in-flight bound ${maxInFlight} reached`;
        break;
      }
      const probeId = `${correlatedRunId}:p:${sent}`;
      if (!REPRO_PROBE_ID.test(probeId)) throw new Error(`invalid generated probe ID ${probeId}`);
      const sample: CorrelatedSample = {
        index: sent,
        probeId,
        startedAtMs: Date.now(),
        outboundFrames: [],
        inboundFrames: [],
      };
      samples.push(sample);
      byProbeId.set(probeId, sample);
      const entry = { sample, settled: Promise.resolve() } as {
        sample: CorrelatedSample;
        settled: Promise<void>;
      };
      entry.settled = discardRpcResult(
        stream.append({
          type: "events.iterate.com/repro/ephemeral-frame",
          ephemeral: true,
          payload: { fixed: "frame", probeId },
        }),
        `correlated frame ${sent}`,
      )
        .catch((error: unknown) => {
          sample.error = errorMessage(error);
          firstRpcFailure ??= `${sample.probeId}: ${sample.error}`;
        })
        .finally(() => {
          sample.settledAtMs = Date.now();
          sample.latencyMs = sample.settledAtMs - sample.startedAtMs;
          byProbeId.delete(sample.probeId);
          pending.delete(entry);
        });
      pending.add(entry);
      sent += 1;
      await sleep(Math.max(0, startedAtMs + sent * periodMs - Date.now()));
    }
    phase = "drain";
    const drainDeadline = Date.now() + drainTimeoutMs;
    while (pending.size > 0 && Date.now() < drainDeadline) await sleep(10);
    if (pending.size > 0) artifact.stopReason ??= `drain left ${pending.size} unresolved RPC(s)`;
    artifact.frameStartedAtMs = startedAtMs;
    artifact.frameEndedAtMs = Date.now();
    artifact.sent = sent;
    artifact.effectiveOutboundSubscriptionCountAfter = outboundSubscriptionCount(
      await readRpcResult(setupStream.runtimeState(), "correlated runtime after"),
    );
    for (const sample of samples) {
      if (sample.settledAtMs === undefined) {
        artifact.correlationErrors.push(`${sample.probeId}: promise did not settle`);
        continue;
      }
      if (sample.outboundFrames.length !== 1 || sample.inboundFrames.length !== 1) {
        artifact.correlationErrors.push(
          `${sample.probeId}: outbound=${sample.outboundFrames.length} inbound=${sample.inboundFrames.length}`,
        );
        continue;
      }
      const outboundAtMs = sample.outboundFrames[0]!.observedAtMs;
      const inboundAtMs = sample.inboundFrames[0]!.observedAtMs;
      if (outboundAtMs < sample.startedAtMs)
        artifact.correlationErrors.push(`${sample.probeId}: outbound frame preceded submit`);
      if (inboundAtMs < outboundAtMs)
        artifact.correlationErrors.push(`${sample.probeId}: inbound frame preceded outbound`);
      if (sample.settledAtMs < inboundAtMs)
        artifact.correlationErrors.push(`${sample.probeId}: settlement preceded inbound frame`);
      sample.stagesMs = {
        submitToOutbound: outboundAtMs - sample.startedAtMs,
        outboundToInbound: inboundAtMs - outboundAtMs,
        inboundToSettle: sample.settledAtMs - inboundAtMs,
      };
    }
  } catch (error) {
    artifact.fatalError = errorMessage(error);
  } finally {
    // This is an explicit client teardown, so a close observed here is
    // distinguishable from a peer close during setup, dispatch, or drain.
    phase = "cleanup";
    disposeClient?.();
    await sleep(10);
    artifact.endedAtMs = Date.now();
    artifact.passed =
      artifact.fatalError === undefined &&
      artifact.stopReason === undefined &&
      artifact.frameScanLimitHit === undefined &&
      artifact.socketCloses.every((close) => close.phase === "cleanup") &&
      artifact.samples.length >= Math.floor(durationMs / periodMs) &&
      artifact.effectiveOutboundSubscriptionCountBefore === 0 &&
      artifact.effectiveOutboundSubscriptionCountAfter === 0 &&
      artifact.samples.every(
        (sample) => sample.settledAtMs !== undefined && sample.error === undefined,
      ) &&
      artifact.correlationErrors.length === 0;
    const outputPath = `/tmp/futurehomes-${correlatedRunId}.json`;
    await writeFile(outputPath, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({ outputPath, ...artifact }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  }
}

void (mode === "read-vs-append"
  ? mainReadVsAppend()
  : mode === "empty-append-v-ephemeral"
    ? mainEmptyAppendVsEphemeral()
    : mode === "correlated-append"
      ? mainCorrelatedAppend()
      : main());
