// Opt-in cumulative Stream benchmark. Run the same client harness against a
// candidate and a baseline server; host-side timers enclose awaited network
// operations because Workers may freeze isolate clocks between I/O events.

import { expect, test } from "vitest";
import type {
  Stream,
  StreamEvent,
  StreamEventInput,
  StreamPushEventBatch,
} from "../../src/itx-api.generated.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const ENABLED = process.env.STREAM_CUMULATIVE_BENCHMARK === "1";
const FOCUS_TAILS = process.env.STREAM_BENCH_FOCUS_TAILS === "1";
const FOCUS_LIVE_TAILS = process.env.STREAM_BENCH_FOCUS_LIVE_TAILS === "1";
const FOCUS_WAIT_FOR_EVENT = process.env.STREAM_BENCH_FOCUS_WAIT_FOR_EVENT === "1";
const FOCUS_PROCESSOR_CATCHUP = process.env.STREAM_BENCH_FOCUS_PROCESSOR_CATCHUP === "1";
const FOCUS_WAKE_SELECTOR = process.env.STREAM_BENCH_FOCUS_WAKE_SELECTOR === "1";
const FOCUS_CROSSPOST_EXACT_RETRY = process.env.STREAM_BENCH_FOCUS_CROSSPOST_EXACT_RETRY === "1";
const FOCUS_STORAGE_JOURNAL = process.env.STREAM_BENCH_FOCUS_STORAGE_JOURNAL === "1";
const FOCUS_WORKER_CONSUMER = process.env.STREAM_BENCH_FOCUS_WORKER_CONSUMER === "1";
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
const CONCURRENT_APPEND_SAMPLES = Number(process.env.STREAM_BENCH_CONCURRENT_APPEND_SAMPLES ?? "0");
const BATCH_SAMPLES = Number(process.env.STREAM_BENCH_BATCH_SAMPLES ?? "0");
const BATCH_SIZE = Number(process.env.STREAM_BENCH_BATCH_SIZE ?? "100");
const DENSE_CROSSPOST_SAMPLES = Number(process.env.STREAM_BENCH_DENSE_CROSSPOST_SAMPLES ?? "0");
const SPARSE_CROSSPOST_SAMPLES = Number(process.env.STREAM_BENCH_SPARSE_CROSSPOST_SAMPLES ?? "0");
const CROSSPOST_RETRY_EVENTS = Number(process.env.STREAM_BENCH_CROSSPOST_RETRY_EVENTS ?? "0");
const CROSSPOST_RETRY_SAMPLES = Number(process.env.STREAM_BENCH_CROSSPOST_RETRY_SAMPLES ?? "0");
const SPARSE_SKIP_SAMPLES = Number(process.env.STREAM_BENCH_SPARSE_SKIP_SAMPLES ?? "0");
const COLD_SAMPLES = Number(process.env.STREAM_BENCH_COLD_SAMPLES ?? "0");
const INLINE_LARGE_SAMPLES = Number(process.env.STREAM_BENCH_INLINE_LARGE_SAMPLES ?? "0");
const CHECKPOINT_CYCLE_SAMPLES = Number(process.env.STREAM_BENCH_CHECKPOINT_CYCLE_SAMPLES ?? "0");
const PROCESSOR_CATCHUP_SAMPLES = Number(process.env.STREAM_BENCH_PROCESSOR_CATCHUP_SAMPLES ?? "0");
const PROCESSOR_CATCHUP_EVENTS = Number(
  process.env.STREAM_BENCH_PROCESSOR_CATCHUP_EVENTS ?? "8000",
);
const WAKE_SELECTOR_SAMPLES = Number(process.env.STREAM_BENCH_WAKE_SELECTOR_SAMPLES ?? "5");
const WAKE_SELECTOR_EVENTS = Number(process.env.STREAM_BENCH_WAKE_SELECTOR_EVENTS ?? "4000");
const WORKER_CONSUMER_SAMPLES = Number(process.env.STREAM_BENCH_WORKER_CONSUMER_SAMPLES ?? "30");
const WORKER_CONSUMER_BATCH_SAMPLES = Number(
  process.env.STREAM_BENCH_WORKER_CONSUMER_BATCH_SAMPLES ?? "12",
);
const WORKER_CONSUMER_BATCH_SIZE = Number(
  process.env.STREAM_BENCH_WORKER_CONSUMER_BATCH_SIZE ?? "100",
);
const WORKER_CONSUMER_PROCESS_EVENT =
  process.env.STREAM_BENCH_WORKER_CONSUMER_PROCESS_EVENT === "1";
const WORKER_CONSUMER_PAIRED = process.env.STREAM_BENCH_WORKER_CONSUMER_PAIRED === "1";
const WORKER_CONSUMER_EPHEMERAL = process.env.STREAM_BENCH_WORKER_CONSUMER_EPHEMERAL === "1";
const WORKER_CONSUMER_PAYLOAD_BYTES = Number(
  process.env.STREAM_BENCH_WORKER_CONSUMER_PAYLOAD_BYTES ?? "0",
);

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

test.skipIf(
  !ENABLED ||
    FOCUS_TAILS ||
    FOCUS_LIVE_TAILS ||
    FOCUS_WAIT_FOR_EVENT ||
    FOCUS_PROCESSOR_CATCHUP ||
    FOCUS_WAKE_SELECTOR ||
    FOCUS_CROSSPOST_EXACT_RETRY ||
    FOCUS_STORAGE_JOURNAL ||
    FOCUS_WORKER_CONSUMER,
)(
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
    const projectId = `prj_${crypto.randomUUID()}`;
    using project = itx.projects.create({
      projectId,
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
        CONCURRENT_APPEND_SAMPLES || 20,
        async (iteration) => {
          await withHostTimeout(
            Promise.all(
              Array.from({ length: 32 }, (_, index) =>
                commitDiscardingResult(
                  stream,
                  event({ marker: `concurrent-${iteration}-${index}-${crypto.randomUUID()}` }),
                ),
              ),
            ),
            `concurrent append iteration ${iteration}`,
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
          await commitDiscardingResult(
            stream,
            event({
              marker: `inline-large-${iteration}-${crypto.randomUUID()}`,
              payload: INLINE_LARGE_PAYLOAD,
            }),
          );
        },
        3,
      );
      metrics.append_single_768k_ack = summarize(appendSamples);

      const head = await readHead(stream);
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
          expect(await readHead(stream)).toMatchObject({ maxOffset: expectedHead });
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
      arrivedAt.delete("live-one-warmup");
      const samples: number[] = [];
      for (let iteration = 0; iteration < (TAIL_SAMPLES || 60); iteration += 1) {
        const marker = `live-one-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(() => arrivedAt.has(marker), `one-subscriber event ${iteration}`);
        samples.push(arrivedAt.get(marker)! - startedAt);
        arrivedAt.delete(marker);
      }
      metrics.live_delivery_one_subscriber = summarize(samples);
      await Promise.resolve(handle.unsubscribe());
    }

    {
      using stream = project.streams.get(`/bench/${runId}/live-fanout`);
      const subscriberCount = 25;
      const arrived = new Map<
        string,
        { receivedAt: number | undefined; subscribers: Set<number> }
      >();
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
                  const delivery = arrived.get(marker) ?? {
                    receivedAt: undefined,
                    subscribers: new Set<number>(),
                  };
                  delivery.subscribers.add(subscriber);
                  if (
                    delivery.subscribers.size === subscriberCount &&
                    delivery.receivedAt === undefined
                  ) {
                    delivery.receivedAt = performance.now();
                  }
                  arrived.set(marker, delivery);
                }
              },
            }),
        ),
      );
      await commitDiscardingResult(stream, event({ marker: "fanout-warmup" }));
      await waitFor(
        () => arrived.get("fanout-warmup")?.receivedAt !== undefined,
        "25-subscriber warmup",
      );
      arrived.delete("fanout-warmup");
      const samples: number[] = [];
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const marker = `fanout-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(
          () => arrived.get(marker)?.receivedAt !== undefined,
          `25-subscriber event ${iteration}`,
        );
        samples.push(arrived.get(marker)!.receivedAt! - startedAt);
        arrived.delete(marker);
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

    if (CHECKPOINT_CYCLE_SAMPLES > 0) {
      const dirtyHotSamples: number[] = [];
      const dirtyColdSamples: number[] = [];
      const dirtyTotalSamples: number[] = [];
      const cleanHotSamples: number[] = [];
      const cleanFlushSamples: number[] = [];
      const cleanColdSamples: number[] = [];
      const cleanTotalSamples: number[] = [];

      const appendFiveBatches = async (stream: StreamHandle, iteration: number) => {
        for (let batch = 0; batch < 5; batch += 1) {
          await stream.append(
            ...Array.from({ length: 100 }, (_, index) =>
              event({
                marker: `checkpoint-${iteration}-${batch}-${index}`,
                payload: "x",
              }),
            ),
          );
        }
      };

      for (let iteration = -2; iteration < CHECKPOINT_CYCLE_SAMPLES; iteration += 1) {
        const path = `/bench/${runId}/checkpoint-dirty-${iteration}`;
        using stream = project.streams.get(path);
        const initialHead = (await stream.head()).maxOffset;
        const totalStartedAt = performance.now();
        const hotStartedAt = performance.now();
        await appendFiveBatches(stream, iteration);
        const hotMs = performance.now() - hotStartedAt;
        await stream.kill().catch(() => undefined);
        using reactivated = project.streams.get(path);
        const coldStartedAt = performance.now();
        const observedHead = (await reactivated.head()).maxOffset;
        const coldMs = performance.now() - coldStartedAt;
        if (observedHead < initialHead + 500)
          throw new Error("Dirty checkpoint cycle lost events.");
        if (iteration >= 0) {
          dirtyHotSamples.push(hotMs);
          dirtyColdSamples.push(coldMs);
          dirtyTotalSamples.push(performance.now() - totalStartedAt);
        }
      }

      for (let iteration = -2; iteration < CHECKPOINT_CYCLE_SAMPLES; iteration += 1) {
        const path = `/bench/${runId}/checkpoint-clean-${iteration}`;
        using stream = project.streams.get(path);
        const initialHead = (await stream.head()).maxOffset;
        const totalStartedAt = performance.now();
        const hotStartedAt = performance.now();
        await appendFiveBatches(stream, iteration);
        const hotMs = performance.now() - hotStartedAt;
        const flushStartedAt = performance.now();
        await forceIdleTeardown(stream);
        const flushMs = performance.now() - flushStartedAt;
        await stream.kill().catch(() => undefined);
        using reactivated = project.streams.get(path);
        const coldStartedAt = performance.now();
        const observedHead = (await reactivated.head()).maxOffset;
        const coldMs = performance.now() - coldStartedAt;
        if (observedHead < initialHead + 500)
          throw new Error("Clean checkpoint cycle lost events.");
        if (iteration >= 0) {
          cleanHotSamples.push(hotMs);
          cleanFlushSamples.push(flushMs);
          cleanColdSamples.push(coldMs);
          cleanTotalSamples.push(performance.now() - totalStartedAt);
        }
      }

      metrics.checkpoint_dirty_hot_5x100 = summarize(dirtyHotSamples, 500);
      metrics.checkpoint_dirty_cold_head = summarize(dirtyColdSamples);
      metrics.checkpoint_dirty_total_cycle = summarize(dirtyTotalSamples, 500);
      metrics.checkpoint_clean_hot_5x100 = summarize(cleanHotSamples, 500);
      metrics.checkpoint_clean_flush = summarize(cleanFlushSamples);
      metrics.checkpoint_clean_cold_head = summarize(cleanColdSamples);
      metrics.checkpoint_clean_total_cycle = summarize(cleanTotalSamples, 500);
    }

    if (PROCESSOR_CATCHUP_SAMPLES > 0) {
      const samples = await measureProcessorCatchup(projectId, PROCESSOR_CATCHUP_SAMPLES);
      metrics.processor_catchup_after_kill = summarize(samples, PROCESSOR_CATCHUP_EVENTS);
    }

    {
      const path = `/bench/${runId}/cold-head`;
      using stream = project.streams.get(path);
      await commitDiscardingResult(stream, event({ marker: "cold-seed" }));
      let expectedHead = (await readHead(stream)).maxOffset;
      const samples: number[] = [];
      for (let iteration = 0; iteration < (COLD_SAMPLES || 20); iteration += 1) {
        await killStreamForBenchmark(projectId, path, iteration);
        using reactivated = project.streams.get(path);
        const startedAt = performance.now();
        const observedHead = (
          await withHostTimeout(readHead(reactivated), `cold head read iteration ${iteration}`)
        ).maxOffset;
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

test.skipIf(!ENABLED || !FOCUS_STORAGE_JOURNAL)(
  "focused Stream storage journal",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }

    const metrics: Record<string, Metric> = {};
    const runId = crypto.randomUUID().slice(0, 8);
    const samples = Number(process.env.STREAM_BENCH_STORAGE_SAMPLES ?? "80");
    if (!Number.isInteger(samples) || samples < 1) {
      throw new Error("STREAM_BENCH_STORAGE_SAMPLES must be a positive integer.");
    }

    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({
      projectId: `prj_${crypto.randomUUID()}`,
      slug: `stream-storage-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    {
      using stream = project.streams.get(`/bench/${runId}/single-1k`);
      metrics.append_single_1k = summarize(
        await measure(
          samples * 2,
          async (iteration) => {
            await stream.append(event({ marker: `single-${iteration}-${runId}` }));
          },
          10,
        ),
      );
    }

    for (const [label, batchSize, payload, sampleDivisor] of [
      ["append_batch_100_tiny", 100, "x", 1],
      ["append_batch_100_1k", 100, SMALL_PAYLOAD, 1],
      ["append_batch_1000_tiny", 1_000, "x", 4],
    ] as const) {
      using stream = project.streams.get(`/bench/${runId}/${label}`);
      const batchSamples = Math.max(10, Math.floor(samples / sampleDivisor));
      metrics[label] = summarize(
        await measure(
          batchSamples,
          async (iteration) => {
            await stream.append(
              ...Array.from({ length: batchSize }, (_, index) =>
                event({ marker: `${label}-${iteration}-${index}`, payload }),
              ),
            );
          },
          5,
        ),
        batchSize,
      );
    }

    {
      using stream = project.streams.get(`/bench/${runId}/batch-keyed`);
      metrics.append_batch_100_keyed_tiny = summarize(
        await measure(
          samples,
          async (iteration) => {
            await stream.append(
              ...Array.from({ length: 100 }, (_, index) =>
                event({
                  idempotencyKey: `keyed-${runId}-${iteration}-${index}`,
                  marker: `keyed-${iteration}-${index}`,
                  payload: "x",
                }),
              ),
            );
          },
          5,
        ),
        100,
      );
    }

    {
      const path = `/bench/${runId}/read-dense`;
      using stream = project.streams.get(path);
      await stream.append(
        ...Array.from({ length: 500 }, (_, index) =>
          event({ marker: `dense-${index}`, payload: SMALL_PAYLOAD }),
        ),
      );
      metrics.read_after_reactivation_dense_500x1k = summarize(
        await measure(
          Math.max(20, Math.floor(samples / 2)),
          async () => {
            await stream.kill().catch(() => undefined);
            using reactivated = project.streams.get(path);
            const events = await reactivated.getEvents({ afterOffset: 0, limit: 500 });
            if (events.length !== 500) throw new Error("Dense cold replay lost events.");
          },
          3,
        ),
      );
    }

    {
      const path = `/bench/${runId}/read-sparse`;
      using stream = project.streams.get(path);
      for (let start = 0; start < 2_000; start += 500) {
        await stream.append(
          ...Array.from({ length: 500 }, (_, index) => {
            const absoluteIndex = start + index;
            return event({
              marker: `sparse-${absoluteIndex}`,
              payload: "x".repeat(128),
              type: absoluteIndex % 100 === 0 ? SELECTED_TYPE : OTHER_TYPE,
            });
          }),
        );
      }
      metrics.read_after_reactivation_sparse_20_of_2000 = summarize(
        await measure(
          Math.max(20, Math.floor(samples / 2)),
          async () => {
            await stream.kill().catch(() => undefined);
            using reactivated = project.streams.get(path);
            const events = await reactivated.getEvents({
              afterOffset: 0,
              eventTypes: [SELECTED_TYPE],
              limit: 500,
            });
            if (events.length !== 20) throw new Error("Sparse cold replay lost selected events.");
          },
          3,
        ),
      );
    }

    for (const [label, payload, sampleDivisor] of [
      ["append_single_768k_inline", INLINE_LARGE_PAYLOAD, 4],
      ["append_single_1100k_chunked", "c".repeat(1_100 * 1_024), 8],
    ] as const) {
      using stream = project.streams.get(`/bench/${runId}/${label}`);
      metrics[label] = summarize(
        await measure(
          Math.max(10, Math.floor(samples / sampleDivisor)),
          async (iteration) => {
            await stream.append(event({ marker: `${label}-${iteration}`, payload }));
          },
          3,
        ),
      );
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

test.skipIf(!ENABLED || !FOCUS_TAILS)(
  "focused Stream append and reactivation tails",
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
    const projectId = `prj_${crypto.randomUUID()}`;
    using project = itx.projects.create({
      projectId,
      slug: `stream-tail-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    {
      using stream = project.streams.get(`/bench/${runId}/append-concurrent`);
      const concurrentSamples = CONCURRENT_APPEND_SAMPLES || 200;
      const samples = await measure(
        concurrentSamples,
        async (iteration) => {
          await withHostTimeout(
            Promise.all(
              Array.from({ length: 32 }, (_, index) =>
                commitDiscardingResult(
                  stream,
                  event({ marker: `concurrent-${iteration}-${index}-${crypto.randomUUID()}` }),
                ),
              ),
            ),
            `focused concurrent append iteration ${iteration}`,
          );
        },
        10,
      );
      metrics.append_concurrent_32_singletons = summarize(samples, 32);
      expect((await readHead(stream)).maxOffset).toBeGreaterThanOrEqual(
        (concurrentSamples + 10) * 32,
      );
    }

    {
      const path = `/bench/${runId}/cold-head`;
      using stream = project.streams.get(path);
      await commitDiscardingResult(stream, event({ marker: "cold-seed" }));
      const expectedHead = (await readHead(stream)).maxOffset;
      const samples: number[] = [];
      for (let iteration = 0; iteration < (COLD_SAMPLES || 100); iteration += 1) {
        await killStreamForBenchmark(projectId, path, iteration);
        using reactivated = project.streams.get(path);
        const startedAt = performance.now();
        const observedHead = (
          await withHostTimeout(
            readHead(reactivated),
            `focused cold head read iteration ${iteration}`,
          )
        ).maxOffset;
        samples.push(performance.now() - startedAt);
        expect(observedHead).toBeGreaterThanOrEqual(expectedHead);
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

test.skipIf(!ENABLED || !FOCUS_LIVE_TAILS)(
  "focused Stream live delivery tails",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }

    const metrics: Record<string, Metric> = {};
    const runId = crypto.randomUUID().slice(0, 8);
    const sampleCount = TAIL_SAMPLES || 300;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({
      projectId: `prj_${crypto.randomUUID()}`,
      slug: `stream-live-tail-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

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
      const samples: number[] = [];

      for (let iteration = -10; iteration < sampleCount; iteration += 1) {
        const marker = `live-one-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(() => arrivedAt.has(marker), `one-subscriber event ${iteration}`);
        if (iteration >= 0) samples.push(arrivedAt.get(marker)! - startedAt);
        arrivedAt.delete(marker);
      }
      metrics.live_delivery_one_subscriber = summarize(samples);
      await Promise.resolve(handle.unsubscribe());
    }

    {
      using stream = project.streams.get(`/bench/${runId}/live-fanout`);
      const subscriberCount = 25;
      const arrived = new Map<
        string,
        { receivedAt: number | undefined; subscribers: Set<number> }
      >();
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
                  const delivery = arrived.get(marker) ?? {
                    receivedAt: undefined,
                    subscribers: new Set<number>(),
                  };
                  delivery.subscribers.add(subscriber);
                  if (
                    delivery.subscribers.size === subscriberCount &&
                    delivery.receivedAt === undefined
                  ) {
                    delivery.receivedAt = performance.now();
                  }
                  arrived.set(marker, delivery);
                }
              },
            }),
        ),
      );
      const samples: number[] = [];
      for (let iteration = -10; iteration < sampleCount; iteration += 1) {
        const marker = `fanout-${iteration}`;
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        await waitFor(
          () => arrived.get(marker)?.receivedAt !== undefined,
          `25-subscriber event ${iteration}`,
        );
        if (iteration >= 0) samples.push(arrived.get(marker)!.receivedAt! - startedAt);
        arrived.delete(marker);
      }
      metrics.live_delivery_25_subscribers = summarize(samples, subscriberCount);
      await Promise.all(handles.map(async (handle) => await Promise.resolve(handle.unsubscribe())));
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

test.skipIf(!ENABLED || !FOCUS_WAIT_FOR_EVENT)(
  "focused Stream waitForEvent latency",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }

    const metrics: Record<string, Metric> = {};
    const runId = crypto.randomUUID().slice(0, 8);
    const sampleCount = TAIL_SAMPLES || 200;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({
      projectId: `prj_${crypto.randomUUID()}`,
      slug: `stream-wait-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    {
      using stream = project.streams.get(`/bench/${runId}/wait-replay`);
      let afterOffset = (await readHead(stream)).maxOffset;
      const samples: number[] = [];
      for (let iteration = -10; iteration < sampleCount; iteration += 1) {
        const marker = `wait-replay-${iteration}`;
        await commitDiscardingResult(stream, event({ marker }));
        const startedAt = performance.now();
        const delivered = await stream.waitForEvent({
          afterOffset,
          eventTypes: [EVENT_TYPE],
          timeoutMs: 15_000,
        });
        if (markerOf(delivered.payload) !== marker) {
          throw new Error(`Replayed wait returned the wrong event for iteration ${iteration}.`);
        }
        if (iteration >= 0) samples.push(performance.now() - startedAt);
        afterOffset = delivered.offset;
      }
      metrics.wait_for_existing_event = summarize(samples);
    }

    {
      using stream = project.streams.get(`/bench/${runId}/wait-live`);
      let afterOffset = (await readHead(stream)).maxOffset;
      const samples: number[] = [];
      for (let iteration = -10; iteration < sampleCount; iteration += 1) {
        const marker = `wait-live-${iteration}`;
        const pending = stream.waitForEvent({
          afterOffset,
          eventTypes: [EVENT_TYPE],
          timeoutMs: 15_000,
        });
        await waitForWaiterConnection(stream);
        const startedAt = performance.now();
        await commitDiscardingResult(stream, event({ marker }));
        const delivered = await pending;
        if (markerOf(delivered.payload) !== marker) {
          throw new Error(`Live wait returned the wrong event for iteration ${iteration}.`);
        }
        if (iteration >= 0) samples.push(performance.now() - startedAt);
        afterOffset = delivered.offset;
      }
      metrics.wait_for_live_event = summarize(samples);
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

test.skipIf(!ENABLED || !FOCUS_PROCESSOR_CATCHUP)(
  "focused hosted processor backlog catch-up",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }
    if (PROCESSOR_CATCHUP_SAMPLES <= 0) {
      throw new Error("STREAM_BENCH_PROCESSOR_CATCHUP_SAMPLES must be positive.");
    }

    const runId = crypto.randomUUID().slice(0, 8);
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    const projectId = `prj_${crypto.randomUUID()}`;
    using project = itx.projects.create({
      projectId,
      slug: `stream-processor-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    const samples = await measureProcessorCatchup(projectId, PROCESSOR_CATCHUP_SAMPLES);
    const output: BenchmarkOutput = {
      implementation: IMPLEMENTATION,
      metrics: {
        processor_catchup_after_kill: summarize(samples, PROCESSOR_CATCHUP_EVENTS),
      },
      revision: REVISION,
      timestamp: new Date().toISOString(),
    };
    console.log(`STREAM_CUMULATIVE_BENCHMARK ${JSON.stringify(output)}`);
  },
  600_000,
);

test.skipIf(!ENABLED || !FOCUS_WAKE_SELECTOR)(
  "focused exact-type wake processor catch-up",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }
    if (!Number.isInteger(WAKE_SELECTOR_SAMPLES) || WAKE_SELECTOR_SAMPLES < 1) {
      throw new Error("STREAM_BENCH_WAKE_SELECTOR_SAMPLES must be a positive integer.");
    }
    if (!Number.isInteger(WAKE_SELECTOR_EVENTS) || WAKE_SELECTOR_EVENTS < 1) {
      throw new Error("STREAM_BENCH_WAKE_SELECTOR_EVENTS must be a positive integer.");
    }

    const runId = crypto.randomUUID().slice(0, 8);
    const auth = { type: "admin-secret" as const, secret: adminSecret() };
    const projectId = `prj_${crypto.randomUUID()}`;
    using session = withItxSession();
    using itx = session.authenticate(auth);
    using project = itx.projects.create({
      projectId,
      slug: `stream-wake-selector-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();
    const agentPath = `/agents/wake-selector-${runId}`;
    using agent = project.agents.get(agentPath);
    const defaults = await project.agents.defaults.forPath(agentPath);
    await agent.stream.append(...defaults.events);
    await agent.processor.snapshot();

    const metrics: Record<string, Metric> = {};
    for (const density of ["sparse", "dense"] as const) {
      const samples: number[] = [];
      for (let iteration = -1; iteration < WAKE_SELECTOR_SAMPLES; iteration += 1) {
        await killAgentForBenchmark(projectId, agentPath, iteration);
        using iterationProject = withItxSession({ auth, projectId });
        using iterationAgent = iterationProject.agents.get(agentPath);
        const initialHead = (
          await withHostTimeout(
            iterationAgent.stream.head(),
            `wake selector head ${density} iteration ${iteration}`,
          )
        ).maxOffset;
        const events = Array.from({ length: WAKE_SELECTOR_EVENTS }, (_, index) =>
          density === "sparse"
            ? event({ marker: `wake-sparse-${iteration}-${index}`, payload: "x" })
            : ({
                type: "events.iterate.com/agent/status-changed",
                payload: { title: `wake-dense-${iteration}-${index}` },
              } satisfies StreamEventInput),
        );
        const startedAt = performance.now();
        await withHostTimeout(
          commitDiscardingResult(iterationAgent.stream, ...events),
          `wake selector append ${density} iteration ${iteration}`,
        );
        await withHostTimeout(
          iterationAgent.processor.waitUntilEvent({
            offset: initialHead + WAKE_SELECTOR_EVENTS,
            timeoutMs: 30_000,
          }),
          `wake selector checkpoint ${density} iteration ${iteration}`,
        );
        if (iteration >= 0) samples.push(performance.now() - startedAt);
      }
      metrics[`wake_selector_${density}_catchup`] = summarize(samples, WAKE_SELECTOR_EVENTS);
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

test.skipIf(!ENABLED || !FOCUS_WORKER_CONSUMER)(
  "focused deployed Worker consumer to Stream DO forwarding",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }
    if (!Number.isInteger(WORKER_CONSUMER_SAMPLES) || WORKER_CONSUMER_SAMPLES < 1) {
      throw new Error("STREAM_BENCH_WORKER_CONSUMER_SAMPLES must be a positive integer.");
    }
    if (!Number.isInteger(WORKER_CONSUMER_BATCH_SAMPLES) || WORKER_CONSUMER_BATCH_SAMPLES < 1) {
      throw new Error("STREAM_BENCH_WORKER_CONSUMER_BATCH_SAMPLES must be a positive integer.");
    }
    const paired = WORKER_CONSUMER_PAIRED || WORKER_CONSUMER_EPHEMERAL;
    const useProcessEvent = WORKER_CONSUMER_PROCESS_EVENT || paired;
    const maxBatchSize = useProcessEvent ? 1_000 : 100;
    if (
      !Number.isInteger(WORKER_CONSUMER_BATCH_SIZE) ||
      WORKER_CONSUMER_BATCH_SIZE < 1 ||
      WORKER_CONSUMER_BATCH_SIZE > maxBatchSize
    ) {
      throw new Error(
        `STREAM_BENCH_WORKER_CONSUMER_BATCH_SIZE must be an integer from 1 to ${maxBatchSize}.`,
      );
    }
    if (!Number.isInteger(WORKER_CONSUMER_PAYLOAD_BYTES) || WORKER_CONSUMER_PAYLOAD_BYTES < 0) {
      throw new Error("STREAM_BENCH_WORKER_CONSUMER_PAYLOAD_BYTES must be a non-negative integer.");
    }

    const runId = crypto.randomUUID().slice(0, 8);
    const sourcePath = `/bench/${runId}/worker-consumer-source`;
    const outputPath = `/bench/${runId}/worker-consumer-output`;
    const triggerType = `${EVENT_TYPE}/worker-consumer-trigger`;
    const baselineTriggerType = `${triggerType}/baseline`;
    const candidateTriggerType = `${triggerType}/candidate`;
    const forwardedType = `${EVENT_TYPE}/worker-consumer-forwarded`;
    const completedType = `${EVENT_TYPE}/worker-consumer-completed`;
    const readyType = `${EVENT_TYPE}/worker-consumer-ready`;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({
      projectId: `prj_${crypto.randomUUID()}`,
      slug: `stream-worker-consumer-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    const processEventWorkerSource = `
      import { IterateWorkerEntrypoint } from "iterate/sdk";

      const SOURCE_PATH = ${JSON.stringify(sourcePath)};
      const OUTPUT_PATH = ${JSON.stringify(outputPath)};
      const TRIGGER_TYPE = ${JSON.stringify(triggerType)};
      const COMPLETED_TYPE = ${JSON.stringify(completedType)};

      export default class ProjectWorker extends IterateWorkerEntrypoint {
        #iteration;
        #receivedCount = 0;

        fetch() {
          return new Response("stream process-event adapter benchmark");
        }

        ${
          WORKER_CONSUMER_PAIRED
            ? `async processEventBatch(batch) {
          const mode = batch.events.find(
            (event) => event.path === SOURCE_PATH && event.type === TRIGGER_TYPE,
          )?.payload.mode;
          if (mode === "baseline") {
            for (const event of batch.events) await this.processEvent(event);
            return;
          }
          if (mode !== "candidate") throw new Error(\`Unknown processEvent mode: \${mode}.\`);
          for (const event of batch.events) {
            const result = this.processEvent(event);
            if (result !== undefined) await result;
          }
        }`
            : ""
        }

        processEvent(event) {
          if (event.path !== SOURCE_PATH || event.type !== TRIGGER_TYPE) return;
          const { count, index, iteration, mode } = event.payload;
          if (index === 0) {
            this.#iteration = iteration;
            this.#receivedCount = 0;
          }
          if (iteration !== this.#iteration || index !== this.#receivedCount) {
            throw new Error(
              \`Out-of-order processEvent: expected \${this.#iteration}#\${this.#receivedCount}, got \${iteration}#\${index}.\`,
            );
          }
          this.#receivedCount += 1;
          if (this.#receivedCount < count) return;
          if (this.#receivedCount !== count) {
            throw new Error(\`processEvent received too many events for \${iteration}.\`);
          }
          this.#iteration = undefined;
          this.#receivedCount = 0;
          return this.#complete(iteration, count, mode, event);
        }

        async #complete(iteration, count, mode, event) {
          const project = await this.env.ITX.get();
          try {
            await project.streams.get(OUTPUT_PATH).append({
              type: COMPLETED_TYPE,
              idempotencyKey: \`worker-completed:\${event.path}@\${event.offset}\`,
              payload: { count, iteration, mode },
            });
          } finally {
            project[Symbol.dispose]?.();
          }
        }
      }
    `;

    const ephemeralProcessEventWorkerSource = `
      import { IterateWorkerEntrypoint, subscribe } from "iterate/sdk";

      const SOURCE_PATH = ${JSON.stringify(sourcePath)};
      const OUTPUT_PATH = ${JSON.stringify(outputPath)};
      const BASELINE_TRIGGER_TYPE = ${JSON.stringify(baselineTriggerType)};
      const CANDIDATE_TRIGGER_TYPE = ${JSON.stringify(candidateTriggerType)};
      const COMPLETED_TYPE = ${JSON.stringify(completedType)};
      const READY_TYPE = ${JSON.stringify(readyType)};

      export default class ProjectWorker extends IterateWorkerEntrypoint {
        #handles = [];
        #project;
        #completed = 0;
        #expectedCompletions = 0;
        #finish;
        #state = {
          baseline: { iteration: undefined, receivedCount: 0 },
          candidate: { iteration: undefined, receivedCount: 0 },
        };

        fetch() {
          return new Response("stream ephemeral process-event adapter benchmark");
        }

        async runEphemeralBenchmark(expectedCompletions) {
          this.#expectedCompletions = expectedCompletions;
          const lifetime = new Promise((resolve) => {
            this.#finish = resolve;
          });
          this.#project = await this.env.ITX.get();
          const source = this.#project.streams.get(SOURCE_PATH);
          this.#handles.push(
            await source.subscribe({
              eventTypes: [BASELINE_TRIGGER_TYPE],
              processEventBatch: async (batch) => {
                let finalEvent;
                for (const event of batch.events) {
                  if (this.#accept(event, "baseline")) finalEvent = event;
                }
                if (finalEvent !== undefined) await this.#complete(finalEvent, "baseline");
              },
            }),
          );
          this.#handles.push(
            await subscribe(source, {
              eventTypes: [CANDIDATE_TRIGGER_TYPE],
              processEvent: (event) => this.#processEvent(event),
            }),
          );
          await this.#project.streams.get(OUTPUT_PATH).append({
            type: READY_TYPE,
            payload: { expectedCompletions },
          });
          return await lifetime;
        }

        #accept(event, mode) {
          const expectedType =
            mode === "baseline" ? BASELINE_TRIGGER_TYPE : CANDIDATE_TRIGGER_TYPE;
          if (event.path !== SOURCE_PATH || event.type !== expectedType) {
            throw new Error(\`Unexpected \${mode} event \${event.path} \${event.type}.\`);
          }
          const { count, index, iteration } = event.payload;
          const state = this.#state[mode];
          if (index === 0) {
            state.iteration = iteration;
            state.receivedCount = 0;
          }
          if (iteration !== state.iteration || index !== state.receivedCount) {
            throw new Error(
              \`Out-of-order ephemeral \${mode} event: expected \${state.iteration}#\${state.receivedCount}, got \${iteration}#\${index}.\`,
            );
          }
          state.receivedCount += 1;
          if (state.receivedCount < count) return false;
          if (state.receivedCount !== count) {
            throw new Error(\`Ephemeral \${mode} received too many events for \${iteration}.\`);
          }
          state.iteration = undefined;
          state.receivedCount = 0;
          return true;
        }

        #processEvent(event) {
          if (this.#accept(event, "candidate")) {
            return this.#complete(event, "candidate");
          }
        }

        async #complete(event, mode) {
          const { count, iteration } = event.payload;
          await this.#project.streams.get(OUTPUT_PATH).append({
            type: COMPLETED_TYPE,
            idempotencyKey: \`ephemeral-\${mode}-completed:\${event.path}@\${event.offset}\`,
            payload: { count, iteration, mode },
          });
          this.#completed += 1;
          if (this.#completed === this.#expectedCompletions) {
            this.#finish({ completed: this.#completed });
          }
        }
      }
    `;

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.ts",
          content: WORKER_CONSUMER_EPHEMERAL
            ? ephemeralProcessEventWorkerSource
            : useProcessEvent
              ? processEventWorkerSource
              : `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SOURCE_PATH = ${JSON.stringify(sourcePath)};
            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const TRIGGER_TYPE = ${JSON.stringify(triggerType)};
            const FORWARDED_TYPE = ${JSON.stringify(forwardedType)};
            const COMPLETED_TYPE = ${JSON.stringify(completedType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() {
                return new Response("stream worker-consumer benchmark");
              }

              async processEventBatch(batch) {
                const events = batch.events.filter(
                  (event) => event.path === SOURCE_PATH && event.type === TRIGGER_TYPE,
                );
                if (events.length === 0) return;

                const project = await this.env.ITX.get();
                const output = project.streams.get(OUTPUT_PATH);
                const iteration = events[0].payload.iteration;
                await output.append(
                  ...events.map((event) => ({
                    type: FORWARDED_TYPE,
                    idempotencyKey: \`worker-forwarded:\${event.path}@\${event.offset}\`,
                    payload: {
                      iteration,
                      sourceOffset: event.offset,
                    },
                  })),
                  {
                    type: COMPLETED_TYPE,
                    idempotencyKey: \`worker-completed:\${events.at(-1).path}@\${events.at(-1).offset}\`,
                    payload: {
                      count: events.length,
                      iteration,
                    },
                  },
                );
              }
            }
          `,
        },
      ],
      message: WORKER_CONSUMER_EPHEMERAL
        ? "Install ephemeral Stream process-event adapter benchmark"
        : useProcessEvent
          ? "Install Stream process-event adapter benchmark"
          : "Install Stream Worker-consumer benchmark",
    });

    using source = project.streams.get(sourcePath);
    using outputStream = project.streams.get(outputPath);
    const expectedCompletions = 2 * (2 + WORKER_CONSUMER_SAMPLES + WORKER_CONSUMER_BATCH_SAMPLES);
    let outputOffset = 0;
    let workerLifetime: Promise<{ completed: number }> | undefined;
    if (WORKER_CONSUMER_EPHEMERAL) {
      const ready = outputStream.waitForEvent({
        afterOffset: outputOffset,
        eventTypes: [readyType],
        timeoutMs: 60_000,
      });
      await waitForWaiterConnection(outputStream, 60_000);
      const benchmarkWorker = project.worker as unknown as {
        runEphemeralBenchmark(expected: number): Promise<{ completed: number }>;
      };
      workerLifetime = benchmarkWorker.runEphemeralBenchmark(expectedCompletions);
      const observedReady = await Promise.race([
        ready,
        workerLifetime.then(() => {
          throw new Error("Ephemeral benchmark Worker completed before it became ready.");
        }),
      ]);
      expect(observedReady.payload?.expectedCompletions).toBe(expectedCompletions);
      outputOffset = observedReady.offset;
    }
    type ProcessEventMode = "baseline" | "candidate";
    const forward = async (
      count: number,
      iteration: string,
      mode?: ProcessEventMode,
    ): Promise<number> => {
      const completed = outputStream.waitForEvent({
        afterOffset: outputOffset,
        eventTypes: [completedType],
        timeoutMs: 60_000,
      });
      await waitForWaiterConnection(outputStream, 60_000);
      const startedAt = performance.now();
      await source.append(
        ...Array.from({ length: count }, (_, index) => ({
          type:
            WORKER_CONSUMER_EPHEMERAL && mode !== undefined
              ? mode === "baseline"
                ? baselineTriggerType
                : candidateTriggerType
              : triggerType,
          payload: {
            blob: "p".repeat(WORKER_CONSUMER_PAYLOAD_BYTES),
            count,
            index,
            iteration,
            mode,
          },
        })),
      );
      let observed: StreamEvent;
      try {
        observed = await completed;
      } catch (error) {
        throw new Error(
          `Worker consumer timed out for ${mode ?? "default"} ${iteration} (${count} events).`,
          { cause: error },
        );
      }
      const elapsedMs = performance.now() - startedAt;
      if (
        observed.payload?.iteration !== iteration ||
        observed.payload?.count !== count ||
        observed.payload?.mode !== mode
      ) {
        throw new Error(`Worker consumer completed the wrong batch for ${iteration}.`);
      }
      outputOffset = observed.offset;
      return elapsedMs;
    };

    const modes: readonly ProcessEventMode[] = paired ? ["baseline", "candidate"] : ["candidate"];
    for (const mode of modes) {
      const payloadMode = paired ? mode : undefined;
      await forward(1, `warmup-${mode}-single`, payloadMode);
      await forward(WORKER_CONSUMER_BATCH_SIZE, `warmup-${mode}-batch`, payloadMode);
    }

    const singletonSamples = new Map(modes.map((mode) => [mode, [] as number[]]));
    for (let iteration = 0; iteration < WORKER_CONSUMER_SAMPLES; iteration += 1) {
      const orderedModes = iteration % 2 === 0 ? modes : [...modes].reverse();
      for (const mode of orderedModes) {
        singletonSamples
          .get(mode)!
          .push(await forward(1, `${mode}-single-${iteration}`, paired ? mode : undefined));
      }
    }

    const batchSamples = new Map(modes.map((mode) => [mode, [] as number[]]));
    for (let iteration = 0; iteration < WORKER_CONSUMER_BATCH_SAMPLES; iteration += 1) {
      const orderedModes = iteration % 2 === 0 ? modes : [...modes].reverse();
      for (const mode of orderedModes) {
        batchSamples
          .get(mode)!
          .push(
            await forward(
              WORKER_CONSUMER_BATCH_SIZE,
              `${mode}-batch-${WORKER_CONSUMER_BATCH_SIZE}-${iteration}`,
              paired ? mode : undefined,
            ),
          );
      }
    }

    const metrics: Record<string, Metric> = {};
    for (const mode of modes) {
      const metricPrefix = WORKER_CONSUMER_EPHEMERAL
        ? `worker_consumer_ephemeral_process_event_shared_transport_paired_${mode}`
        : WORKER_CONSUMER_PAIRED
          ? `worker_consumer_process_event_paired_${mode}`
          : WORKER_CONSUMER_PROCESS_EVENT
            ? "worker_consumer_process_event"
            : "worker_consumer_forward";
      metrics[`${metricPrefix}_single`] = summarize(singletonSamples.get(mode)!);
      metrics[
        `${metricPrefix}_batch_${WORKER_CONSUMER_BATCH_SIZE}x${WORKER_CONSUMER_PAYLOAD_BYTES}`
      ] = summarize(batchSamples.get(mode)!, WORKER_CONSUMER_BATCH_SIZE);
    }
    if (workerLifetime) {
      await expect(workerLifetime).resolves.toEqual({ completed: expectedCompletions });
    }
    const output: BenchmarkOutput = {
      implementation: IMPLEMENTATION,
      metrics,
      revision: REVISION,
      timestamp: new Date().toISOString(),
    };
    console.log(`STREAM_CUMULATIVE_BENCHMARK ${JSON.stringify(output)}`);
  },
  900_000,
);

test.skipIf(!ENABLED || !FOCUS_CROSSPOST_EXACT_RETRY)(
  "focused exact cross-post delivery retry",
  async () => {
    if (IMPLEMENTATION !== "candidate" && IMPLEMENTATION !== "main") {
      throw new Error("STREAM_BENCH_IMPLEMENTATION must be candidate or main.");
    }

    const metrics: Record<string, Metric> = {};
    const runId = crypto.randomUUID().slice(0, 8);
    const projectId = `prj_${crypto.randomUUID()}`;
    const sampleCount = CROSSPOST_RETRY_SAMPLES || 30;
    const createdAt = new Date(0).toISOString();

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({
      projectId,
      slug: `stream-crosspost-retry-${IMPLEMENTATION}-${runId}`,
    });
    await project.__describe();

    for (const eventCount of [1, 128, 8_000]) {
      const sourcePath = `/bench/${runId}/exact-retry-source-${eventCount}`;
      const destinationPath = `/bench/${runId}/exact-retry-destination-${eventCount}`;
      const subscriptionKey = `exact-retry-${runId}-${eventCount}`;
      const events: StreamEvent[] = Array.from({ length: eventCount }, (_, index) => ({
        createdAt,
        offset: index + 1,
        path: sourcePath,
        payload: { marker: `exact-retry-${eventCount}-${index}` },
        type: SELECTED_TYPE,
      }));
      const batch: StreamPushEventBatch = {
        attempt: 1,
        configuredEvent: {
          createdAt,
          offset: eventCount + 1,
          path: sourcePath,
          payload: { params: {} },
          type: "events.iterate.com/stream/subscription-configured",
        },
        deliveryId: `${subscriptionKey}:1-${eventCount}`,
        events,
        path: sourcePath,
        projectId,
        streamMaxOffset: eventCount + 1,
        subscriptionKey,
      };

      using destination = project.streams.get(destinationPath);
      const initialHead = (await destination.head()).maxOffset;
      await acceptCrossPostDirect(destination, batch);
      expect(await destination.head()).toMatchObject({ maxOffset: initialHead + eventCount });

      const samples = await measure(
        sampleCount,
        async () => await acceptCrossPostDirect(destination, batch),
        5,
      );
      metrics[`crosspost_exact_retry_${eventCount}`] = summarize(samples, eventCount);
      expect(await destination.head()).toMatchObject({ maxOffset: initialHead + eventCount });
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

async function waitForWaiterConnection(stream: StreamHandle, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const connections = (await stream.runtimeState()).runtime.connections;
    const established = Object.values(connections).some((connection) => {
      const subscriber = connection.subscriber as { description?: unknown } | undefined;
      return subscriber?.description === "waitForEvent";
    });
    if (established) return;
    if (performance.now() > deadline) {
      throw new Error("Timed out waiting for waitForEvent connection.");
    }
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
    await stream.append(...events);
    return;
  }
  void (await stream.append(...events));
}

async function readHead(stream: StreamHandle): Promise<{ maxOffset: number }> {
  if (IMPLEMENTATION === "candidate") return await stream.head();
  const state = (await stream.runtimeState()).coreProcessorState as { maxOffset: number };
  return { maxOffset: state.maxOffset };
}

async function forceIdleTeardown(stream: StreamHandle): Promise<void> {
  await (
    stream as unknown as {
      durableObjectStub: { runIdleTeardownNow(): Promise<void> | void };
    }
  ).durableObjectStub.runIdleTeardownNow();
}

async function acceptCrossPostDirect(
  stream: StreamHandle,
  batch: StreamPushEventBatch,
): Promise<void> {
  await (
    stream as unknown as {
      durableObjectStub: {
        acceptCrossPost(batch: StreamPushEventBatch): Promise<void> | void;
      };
    }
  ).durableObjectStub.acceptCrossPost(batch);
}

async function killProject(project: { kill(): Promise<void> }): Promise<void> {
  try {
    await project.kill();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("kill requested")) throw error;
  }
}

async function killAgentForBenchmark(
  projectId: string,
  agentPath: string,
  iteration: number,
): Promise<void> {
  const auth = { type: "admin-secret" as const, secret: adminSecret() };
  using project = withItxSession({ auth, projectId });
  using agent = project.agents.get(agentPath);
  try {
    await withHostTimeout(agent.kill(), `forced Agent kill iteration ${iteration}`);
  } catch (error) {
    if (error instanceof HostTimeoutError) throw error;
    if (!(error instanceof Error) || !error.message.includes("kill requested")) throw error;
  }
}

class HostTimeoutError extends Error {}

async function withHostTimeout<T>(
  operation: PromiseLike<T>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HostTimeoutError(`Timed out after ${timeoutMs} ms: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function killStreamForBenchmark(
  projectId: string,
  path: string,
  iteration: number,
): Promise<void> {
  const auth = { type: "admin-secret" as const, secret: adminSecret() };
  using project = withItxSession({ auth, projectId });
  using stream = project.streams.get(path);
  try {
    await withHostTimeout(stream.kill(), `forced Stream kill iteration ${iteration}`);
  } catch (error) {
    if (error instanceof HostTimeoutError) throw error;
  }
}

async function measureProcessorCatchup(projectId: string, samples: number): Promise<number[]> {
  const measured: number[] = [];
  const auth = { type: "admin-secret" as const, secret: adminSecret() };
  for (let iteration = -2; iteration < samples; iteration += 1) {
    {
      using killer = withItxSession({ auth, projectId });
      await killProject(killer);
    }

    using project = withItxSession({ auth, projectId });
    using stream = project.streams.get("/");
    const initialHead = (await stream.head()).maxOffset;
    const startedAt = performance.now();
    await stream.append(
      ...Array.from({ length: PROCESSOR_CATCHUP_EVENTS }, (_, index) =>
        event({ marker: `processor-catchup-${iteration}-${index}`, payload: "x" }),
      ),
    );
    const expectedOffset = initialHead + PROCESSOR_CATCHUP_EVENTS;
    await project.processor.waitUntilEvent({ offset: expectedOffset, timeoutMs: 30_000 });
    if (iteration >= 0) measured.push(performance.now() - startedAt);
  }
  return measured;
}
