// Opt-in cumulative Stream benchmark. Run the same client harness against a
// candidate and a baseline server; host-side timers enclose awaited network
// operations because Workers may freeze isolate clocks between I/O events.

import { expect, test } from "vitest";
import type { Stream, StreamEventInput } from "../../src/itx-api.generated.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const ENABLED = process.env.STREAM_CUMULATIVE_BENCHMARK === "1";
const IMPLEMENTATION = process.env.STREAM_BENCH_IMPLEMENTATION;
const REVISION = process.env.STREAM_BENCH_REVISION ?? "unknown";
const EVENT_TYPE = "events.iterate.test/stream-cumulative-benchmark";
const SELECTED_TYPE = `${EVENT_TYPE}/selected`;
const OTHER_TYPE = `${EVENT_TYPE}/other`;
const SMALL_PAYLOAD = "s".repeat(1_024);
const MEDIUM_PAYLOAD = "m".repeat(4_096);
const LARGE_PAYLOAD = "l".repeat(256 * 1_024);
const INLINE_LARGE_PAYLOAD = "i".repeat(768 * 1_024);
const TAIL_SAMPLES = Number(process.env.STREAM_BENCH_TAIL_SAMPLES ?? "0");
const APPEND_SAMPLES = Number(process.env.STREAM_BENCH_APPEND_SAMPLES ?? "0");
const BATCH_SAMPLES = Number(process.env.STREAM_BENCH_BATCH_SAMPLES ?? "0");
const BATCH_SIZE = Number(process.env.STREAM_BENCH_BATCH_SIZE ?? "100");
const DENSE_CROSSPOST_SAMPLES = Number(process.env.STREAM_BENCH_DENSE_CROSSPOST_SAMPLES ?? "0");
const SPARSE_CROSSPOST_SAMPLES = Number(process.env.STREAM_BENCH_SPARSE_CROSSPOST_SAMPLES ?? "0");
const CROSSPOST_RETRY_EVENTS = Number(process.env.STREAM_BENCH_CROSSPOST_RETRY_EVENTS ?? "0");
const CROSSPOST_RETRY_SAMPLES = Number(process.env.STREAM_BENCH_CROSSPOST_RETRY_SAMPLES ?? "0");
const SPARSE_SKIP_SAMPLES = Number(process.env.STREAM_BENCH_SPARSE_SKIP_SAMPLES ?? "0");
const COLD_SAMPLES = Number(process.env.STREAM_BENCH_COLD_SAMPLES ?? "0");
const INLINE_LARGE_SAMPLES = Number(process.env.STREAM_BENCH_INLINE_LARGE_SAMPLES ?? "0");

type StreamHandle = Stream & Disposable;

type Metric = {
  maxMs: number;
  meanMs: number;
  minMs: number;
  operationsPerSecond?: number;
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
};

type BenchmarkOutput = {
  implementation: string;
  metrics: Record<string, Metric>;
  revision: string;
  timestamp: string;
};

function quantile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(samples: readonly number[], operationsPerSample?: number): Metric {
  const sorted = [...samples].sort((left, right) => left - right);
  const meanMs = samples.reduce((total, sample) => total + sample, 0) / samples.length;
  const metric: Metric = {
    maxMs: sorted.at(-1)!,
    meanMs,
    minMs: sorted[0]!,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    samplesMs: [...samples],
  };
  if (operationsPerSample !== undefined) {
    metric.operationsPerSecond = (operationsPerSample * 1_000) / metric.p50Ms;
  }
  return metric;
}

async function measure(
  iterations: number,
  operation: (iteration: number) => Promise<void>,
  warmups = Math.min(5, iterations),
): Promise<number[]> {
  for (let iteration = -warmups; iteration < 0; iteration += 1) await operation(iteration);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    await operation(iteration);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function markerOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("marker" in payload)) return undefined;
  const marker = payload.marker;
  return typeof marker === "string" ? marker : undefined;
}

function event(input: {
  idempotencyKey?: string;
  marker: string;
  payload?: string;
  type?: string;
}): StreamEventInput {
  return {
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    payload: { blob: input.payload ?? SMALL_PAYLOAD, marker: input.marker },
    type: input.type ?? EVENT_TYPE,
  };
}

async function commitDiscardingResult(
  stream: StreamHandle,
  ...events: StreamEventInput[]
): Promise<void> {
  if (IMPLEMENTATION === "candidate") {
    await stream.appendAck(...events);
    return;
  }
  void (await stream.append(...events));
}

async function readHead(stream: StreamHandle): Promise<{ maxOffset: number }> {
  if (IMPLEMENTATION === "candidate") return await stream.head();
  const state = (await stream.runtimeState()).coreProcessorState as { maxOffset: number };
  return { maxOffset: state.maxOffset };
}

test.skipIf(!ENABLED)(
  "cumulative Stream latency and throughput",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }

    const metrics: Record<string, Metric> = {};
    const runId = crypto.randomUUID().slice(0, 8);

    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({
      projectId: `prj_${crypto.randomUUID()}`,
      slug: `stream-cumulative-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    {
      using stream = project.streams.get(`/bench/${runId}/append-single`);
      const samples = await measure(
        APPEND_SAMPLES || 80,
        async (iteration) => {
          await commitDiscardingResult(
            stream,
            event({ marker: `single-${iteration}-${crypto.randomUUID()}` }),
          );
        },
        10,
      );
      metrics.append_single_1k_no_result = summarize(samples);
      expect(
        await stream.getEvents({ afterOffset: 0, eventTypes: [EVENT_TYPE], limit: 500 }),
      ).toHaveLength(Math.min((APPEND_SAMPLES || 80) + 10, 500));
    }

    {
      using stream = project.streams.get(`/bench/${runId}/append-batch`);
      const batchSamples = BATCH_SAMPLES || 20;
      const samples = await measure(
        batchSamples,
        async (iteration) => {
          await commitDiscardingResult(
            stream,
            ...Array.from({ length: BATCH_SIZE }, (_, index) =>
              event({ marker: `batch-${iteration}-${index}` }),
            ),
          );
        },
        3,
      );
      metrics[`append_batch_${BATCH_SIZE}_tiny`] = summarize(samples, BATCH_SIZE);
      const head = await readHead(stream);
      expect(head.maxOffset).toBeGreaterThanOrEqual((batchSamples + 3) * BATCH_SIZE);
      const replaySize = Math.min(BATCH_SIZE, 500);
      expect(
        (
          await stream.getEvents({
            afterOffset: head.maxOffset - replaySize,
            eventTypes: [EVENT_TYPE],
            limit: replaySize,
          })
        ).map((entry) => markerOf(entry.payload)),
      ).toEqual(
        Array.from(
          { length: replaySize },
          (_, index) => `batch-${batchSamples - 1}-${BATCH_SIZE - replaySize + index}`,
        ),
      );
    }

    {
      using stream = project.streams.get(`/bench/${runId}/append-concurrent`);
      const samples = await measure(
        20,
        async (iteration) => {
          await Promise.all(
            Array.from({ length: 32 }, (_, index) =>
              commitDiscardingResult(
                stream,
                event({ marker: `concurrent-${iteration}-${index}-${crypto.randomUUID()}` }),
              ),
            ),
          );
        },
        3,
      );
      metrics.append_concurrent_32_singletons = summarize(samples, 32);
      expect((await readHead(stream)).maxOffset).toBeGreaterThanOrEqual(736);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/append-large`);
      const samples = await measure(
        20,
        async (iteration) => {
          await commitDiscardingResult(
            stream,
            event({ marker: `large-${iteration}-${crypto.randomUUID()}`, payload: LARGE_PAYLOAD }),
          );
        },
        3,
      );
      metrics.append_single_256k_no_result = summarize(samples);
      expect(
        await stream.getEvents({ afterOffset: 0, eventTypes: [EVENT_TYPE], limit: 500 }),
      ).toHaveLength(23);
    }

    if (INLINE_LARGE_SAMPLES > 0) {
      using stream = project.streams.get(`/bench/${runId}/inline-large`);
      const appendSamples = await measure(
        INLINE_LARGE_SAMPLES,
        async (iteration) => {
          await stream.appendAck(
            event({
              marker: `inline-large-${iteration}-${crypto.randomUUID()}`,
              payload: INLINE_LARGE_PAYLOAD,
            }),
          );
        },
        3,
      );
      metrics.append_single_768k_ack = summarize(appendSamples);

      const head = await stream.head();
      const readSamples = await measure(
        INLINE_LARGE_SAMPLES,
        async () => {
          const events = await stream.getEvents({
            afterOffset: head.maxOffset - 1,
            eventTypes: [EVENT_TYPE],
            limit: 1,
          });
          if (events.length !== 1) throw new Error("768 KiB replay missed its selected event.");
        },
        3,
      );
      metrics.read_single_768k = summarize(readSamples);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/append-duplicate`);
      const duplicate = event({
        idempotencyKey: `duplicate-${runId}`,
        marker: "large-duplicate",
        payload: LARGE_PAYLOAD,
      });
      await commitDiscardingResult(stream, duplicate);
      const samples = await measure(
        30,
        async () => {
          await commitDiscardingResult(stream, duplicate);
        },
        5,
      );
      metrics.append_duplicate_256k_no_result = summarize(samples);
      expect(await stream.getEvents({ afterOffset: 0, eventTypes: [EVENT_TYPE] })).toHaveLength(1);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/head-hot`);
      await commitDiscardingResult(stream, event({ marker: "head-seed" }));
      const expectedHead = (await readHead(stream)).maxOffset;
      const samples = await measure(
        80,
        async () => {
          expect((await readHead(stream)).maxOffset).toBe(expectedHead);
        },
        10,
      );
      metrics.head_hot = summarize(samples);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/read-dense`);
      await commitDiscardingResult(
        stream,
        ...Array.from({ length: 500 }, (_, index) =>
          event({ marker: `dense-${index}`, payload: MEDIUM_PAYLOAD }),
        ),
      );
      const samples = await measure(
        20,
        async () => {
          expect(await stream.getEvents({ afterOffset: 0, limit: 500 })).toHaveLength(500);
        },
        3,
      );
      metrics.read_dense_500x4k = summarize(samples);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/read-sparse`);
      for (let chunk = 0; chunk < 4; chunk += 1) {
        await commitDiscardingResult(
          stream,
          ...Array.from({ length: 500 }, (_, index) => {
            const absoluteIndex = chunk * 500 + index;
            return event({
              marker: `sparse-${absoluteIndex}`,
              payload: "x".repeat(128),
              type: absoluteIndex % 100 === 0 ? SELECTED_TYPE : OTHER_TYPE,
            });
          }),
        );
      }
      const filteredSamples = await measure(
        TAIL_SAMPLES || 30,
        async () => {
          expect(
            await stream.getEvents({ afterOffset: 0, eventTypes: [SELECTED_TYPE], limit: 500 }),
          ).toHaveLength(20);
        },
        5,
      );
      metrics.read_sparse_20_of_2000 = summarize(filteredSamples);

      const latestSamples = await measure(
        TAIL_SAMPLES || 30,
        async () => {
          if (IMPLEMENTATION === "candidate") {
            const latest = await stream.getEvents({
              eventTypes: [SELECTED_TYPE],
              limit: 1,
              order: "desc",
            });
            expect(markerOf(latest[0]?.payload)).toBe("sparse-1900");
            return;
          }
          const selected = await stream.getEvents({
            afterOffset: 0,
            eventTypes: [SELECTED_TYPE],
            limit: 500,
          });
          expect(markerOf(selected.at(-1)?.payload)).toBe("sparse-1900");
        },
        5,
      );
      metrics.read_latest_sparse_match = summarize(latestSamples);
    }

    {
      const samples: number[] = [];
      for (let iteration = 0; iteration < 10; iteration += 1) {
        using stream = project.streams.get(`/bench/${runId}/replay-${iteration}`);
        await commitDiscardingResult(
          stream,
          ...Array.from({ length: 500 }, (_, index) =>
            event({ marker: `replay-${iteration}-${index}`, payload: "r".repeat(128) }),
          ),
        );
        let received = 0;
        const startedAt = performance.now();
        const handle = await stream.subscribe({
          eventTypes: [EVENT_TYPE],
          processEventBatch: (batch) => {
            received += batch.events.length;
          },
          replayAfterOffset: 0,
        });
        await waitFor(() => received === 500, `500 replay events for iteration ${iteration}`);
        samples.push(performance.now() - startedAt);
        await Promise.resolve(handle.unsubscribe());
      }
      metrics.replay_subscribe_500x128 = summarize(samples, 500);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/live-one`);
      const arrivedAt = new Map<string, number>();
      const handle = await stream.subscribe({
        eventTypes: [EVENT_TYPE],
        processEventBatch: (batch) => {
          const now = performance.now();
          for (const delivered of batch.events) {
            const marker = markerOf(delivered.payload);
            if (marker !== undefined && !arrivedAt.has(marker)) arrivedAt.set(marker, now);
          }
        },
      });
      await commitDiscardingResult(stream, event({ marker: "live-one-warmup" }));
      await waitFor(() => arrivedAt.has("live-one-warmup"), "one-subscriber warmup");
      const samples: number[] = [];
      for (let iteration = 0; iteration < (TAIL_SAMPLES || 60); iteration += 1) {
        const marker = `live-one-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(() => arrivedAt.has(marker), `one-subscriber event ${iteration}`);
        samples.push(arrivedAt.get(marker)! - startedAt);
      }
      metrics.live_delivery_one_subscriber = summarize(samples);
      await Promise.resolve(handle.unsubscribe());
    }

    {
      using stream = project.streams.get(`/bench/${runId}/live-fanout`);
      const subscriberCount = 25;
      const arrived = new Map<string, Set<number>>();
      const handles = await Promise.all(
        Array.from(
          { length: subscriberCount },
          async (_, subscriber) =>
            await stream.subscribe({
              eventTypes: [EVENT_TYPE],
              processEventBatch: (batch) => {
                for (const delivered of batch.events) {
                  const marker = markerOf(delivered.payload);
                  if (marker === undefined) continue;
                  const subscribers = arrived.get(marker) ?? new Set<number>();
                  subscribers.add(subscriber);
                  arrived.set(marker, subscribers);
                }
              },
            }),
        ),
      );
      await commitDiscardingResult(stream, event({ marker: "fanout-warmup" }));
      await waitFor(
        () => arrived.get("fanout-warmup")?.size === subscriberCount,
        "25-subscriber warmup",
      );
      const samples: number[] = [];
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const marker = `fanout-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(
          () => arrived.get(marker)?.size === subscriberCount,
          `25-subscriber event ${iteration}`,
        );
        samples.push(performance.now() - startedAt);
      }
      metrics.live_delivery_25_subscribers = summarize(samples, subscriberCount);
      await Promise.all(handles.map(async (handle) => await Promise.resolve(handle.unsubscribe())));
    }

    {
      using source = project.streams.get(`/bench/${runId}/crosspost-dense-source`);
      using destination = project.streams.get(`/bench/${runId}/crosspost-dense-destination`);
      const arrivedAt = new Map<string, number>();
      const handle = await destination.subscribe({
        eventTypes: [SELECTED_TYPE],
        processEventBatch: (batch) => {
          const now = performance.now();
          for (const delivered of batch.events) {
            const marker = markerOf(delivered.payload);
            if (marker !== undefined && !arrivedAt.has(marker)) arrivedAt.set(marker, now);
          }
        },
      });
      await source.crossPostTo({
        deliver: "new",
        eventTypes: [SELECTED_TYPE],
        key: `dense-${runId}`,
        path: `/bench/${runId}/crosspost-dense-destination`,
      });
      await commitDiscardingResult(
        source,
        event({ marker: "crosspost-dense-warmup", type: SELECTED_TYPE }),
      );
      await waitFor(() => arrivedAt.has("crosspost-dense-warmup"), "dense cross-post warmup");
      const samples: number[] = [];
      for (let iteration = 0; iteration < (DENSE_CROSSPOST_SAMPLES || 30); iteration += 1) {
        const marker = `crosspost-dense-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(source, event({ marker, type: SELECTED_TYPE }));
        await waitFor(() => arrivedAt.has(marker), `dense cross-post ${iteration}`);
        samples.push(arrivedAt.get(marker)! - startedAt);
      }
      metrics.crosspost_dense_one_event = summarize(samples);
      await Promise.resolve(handle.unsubscribe());
    }

    {
      using source = project.streams.get(`/bench/${runId}/crosspost-sparse-source`);
      using destination = project.streams.get(`/bench/${runId}/crosspost-sparse-destination`);
      const arrivedAt = new Map<string, number>();
      const handle = await destination.subscribe({
        eventTypes: [SELECTED_TYPE],
        processEventBatch: (batch) => {
          const now = performance.now();
          for (const delivered of batch.events) {
            const marker = markerOf(delivered.payload);
            if (marker !== undefined && !arrivedAt.has(marker)) arrivedAt.set(marker, now);
          }
        },
      });
      await source.crossPostTo({
        deliver: "new",
        eventTypes: [SELECTED_TYPE],
        key: `sparse-${runId}`,
        path: `/bench/${runId}/crosspost-sparse-destination`,
      });
      await commitDiscardingResult(
        source,
        event({ marker: "crosspost-sparse-warmup", type: SELECTED_TYPE }),
      );
      await waitFor(() => arrivedAt.has("crosspost-sparse-warmup"), "sparse cross-post warmup");
      const samples: number[] = [];
      for (let iteration = 0; iteration < (SPARSE_CROSSPOST_SAMPLES || 20); iteration += 1) {
        const marker = `crosspost-sparse-${iteration}`;
        const batch = Array.from({ length: 100 }, (_, index) =>
          event({
            marker: index === 99 ? marker : `ignored-${iteration}-${index}`,
            payload: "p".repeat(128),
            type: index === 99 ? SELECTED_TYPE : OTHER_TYPE,
          }),
        );
        const startedAt = performance.now();
        await commitDiscardingResult(source, ...batch);
        await waitFor(() => arrivedAt.has(marker), `sparse cross-post ${iteration}`);
        samples.push(arrivedAt.get(marker)! - startedAt);
      }
      metrics.crosspost_sparse_1_of_100 = summarize(samples);
      await Promise.resolve(handle.unsubscribe());
    }

    if (CROSSPOST_RETRY_EVENTS > 0) {
      if (!Number.isInteger(CROSSPOST_RETRY_EVENTS) || CROSSPOST_RETRY_EVENTS > 128) {
        throw new Error(
          "STREAM_BENCH_CROSSPOST_RETRY_EVENTS must be an integer from 1 through 128",
        );
      }
      const sampleCount = CROSSPOST_RETRY_SAMPLES || 10;
      const samples: number[] = [];
      for (let iteration = -2; iteration < sampleCount; iteration += 1) {
        const sourcePath = `/bench/${runId}/crosspost-retry-source-${iteration}`;
        const destinationPath = `/bench/${runId}/crosspost-retry-destination-${iteration}`;
        const subscriptionKey = `retry-${runId}-${iteration}`;
        using source = project.streams.get(sourcePath);
        using destination = project.streams.get(destinationPath);
        const arrived = new Set<string>();
        const handle = await destination.subscribe({
          eventTypes: [SELECTED_TYPE],
          processEventBatch: (batch) => {
            for (const delivered of batch.events) {
              const marker = markerOf(delivered.payload);
              if (marker !== undefined) arrived.add(marker);
            }
          },
        });
        await commitDiscardingResult(
          source,
          ...Array.from({ length: CROSSPOST_RETRY_EVENTS }, (_, index) =>
            event({
              marker: `retry-${iteration}-${index}`,
              payload: LARGE_PAYLOAD,
              type: SELECTED_TYPE,
            }),
          ),
        );
        const configure = () =>
          source.crossPostTo({
            deliver: "all",
            eventTypes: [SELECTED_TYPE],
            key: subscriptionKey,
            path: destinationPath,
          });
        const waitForAck = async (offset: number) => {
          const deadline = performance.now() + 30_000;
          for (;;) {
            const state = await source.runtimeState();
            if ((state.runtime.subscriptions[subscriptionKey]?.ackedOffset ?? 0) >= offset) return;
            if (performance.now() > deadline) {
              throw new Error(`Timed out waiting for duplicate cross-post ack at ${offset}.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        };
        const initialConfig = await configure();
        await waitFor(
          () => arrived.size === CROSSPOST_RETRY_EVENTS,
          `${CROSSPOST_RETRY_EVENTS} initial cross-post events for iteration ${iteration}`,
          30_000,
        );
        await waitForAck(initialConfig.offset);

        const startedAt = performance.now();
        const replayedConfig = await configure();
        await waitForAck(replayedConfig.offset);
        if (iteration >= 0) samples.push(performance.now() - startedAt);
        expect(
          await destination.getEvents({ eventTypes: [SELECTED_TYPE], limit: 500 }),
        ).toHaveLength(CROSSPOST_RETRY_EVENTS);
        await Promise.resolve(handle.unsubscribe());
      }
      metrics[`crosspost_retry_${CROSSPOST_RETRY_EVENTS}x256k`] = summarize(
        samples,
        CROSSPOST_RETRY_EVENTS,
      );
    }

    if (SPARSE_SKIP_SAMPLES > 0) {
      if (!Number.isInteger(SPARSE_SKIP_SAMPLES)) {
        throw new Error("STREAM_BENCH_SPARSE_SKIP_SAMPLES must be a positive integer");
      }
      const rawRows = 8_000;
      const samples: number[] = [];
      for (let iteration = -2; iteration < SPARSE_SKIP_SAMPLES; iteration += 1) {
        const sourcePath = `/bench/${runId}/sparse-skip-source-${iteration}`;
        const destinationPath = `/bench/${runId}/sparse-skip-destination-${iteration}`;
        const subscriptionKey = `sparse-skip-${runId}-${iteration}`;
        using source = project.streams.get(sourcePath);
        using destination = project.streams.get(destinationPath);
        for (let offset = 0; offset < rawRows - 1; offset += 500) {
          const batchSize = Math.min(500, rawRows - 1 - offset);
          await commitDiscardingResult(
            source,
            ...Array.from({ length: batchSize }, (_, index) =>
              event({
                marker: `sparse-skip-${iteration}-${offset + index}`,
                payload: "x",
                type: OTHER_TYPE,
              }),
            ),
          );
        }

        const startedAt = performance.now();
        const configured = await source.crossPostTo({
          deliver: "all",
          eventTypes: [SELECTED_TYPE],
          key: subscriptionKey,
          path: destinationPath,
        });
        if (iteration >= 0) samples.push(performance.now() - startedAt);
        const state = await source.runtimeState();
        expect(state.runtime.subscriptions[subscriptionKey]?.ackedOffset).toBeGreaterThanOrEqual(
          configured.offset,
        );
        expect(await destination.getEvents({ eventTypes: [SELECTED_TYPE], limit: 1 })).toEqual([]);
      }
      metrics.crosspost_sparse_skip_8000_rows = summarize(samples, rawRows);
    }

    {
      const path = `/bench/${runId}/cold-head`;
      using stream = project.streams.get(path);
      await commitDiscardingResult(stream, event({ marker: "cold-seed" }));
      let expectedHead = (await readHead(stream)).maxOffset;
      const samples: number[] = [];
      for (let iteration = 0; iteration < (COLD_SAMPLES || 20); iteration += 1) {
        await stream.kill().catch(() => undefined);
        using reactivated = project.streams.get(path);
        const startedAt = performance.now();
        const observedHead = (await readHead(reactivated)).maxOffset;
        samples.push(performance.now() - startedAt);
        expect(observedHead).toBeGreaterThanOrEqual(expectedHead);
        expectedHead = observedHead;
      }
      metrics.head_after_forced_reactivation = summarize(samples);
    }

    const output: BenchmarkOutput = {
      implementation: IMPLEMENTATION,
      metrics,
      revision: REVISION,
      timestamp: new Date().toISOString(),
    };
    console.log(`STREAM_CUMULATIVE_BENCHMARK ${JSON.stringify(output)}`);
  },
  600_000,
);
