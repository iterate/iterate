import { describe, expect, test } from "vitest";

import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";
import {
  appendSubscriptionRegistration,
  disposeWithTimeout,
  startWebhookFixture,
  type WebhookFixture,
  uniquePath,
  waitUntil,
  withTimeout,
} from "./testing/subscriptions-test-helpers.ts";

interface BenchmarkLoad {
  readonly publishers: number;
  readonly consumers: number;
  readonly eventsPerPublisher: number;
}

interface BenchmarkMetrics {
  readonly scenario: string;
  readonly publishers: number;
  readonly consumers: number;
  readonly eventsPerPublisher: number;
  readonly appendBatchSize: number;
  readonly publishedEvents: number;
  readonly deliveryEvents: number;
  readonly publishDurationMs: number;
  readonly endToEndDurationMs: number;
  readonly appendBatchLatencyP95Ms: number;
  readonly publishEventsPerSecond: number;
  readonly deliveryEventsPerSecond: number;
}

const BENCH_TEST_TIMEOUT_MS = Number.parseInt(
  process.env.BENCH_SUBSCRIPTIONS_TEST_TIMEOUT_MS ?? "180000",
  10,
);
const ITERATOR_TIMEOUT_MS = Number.parseInt(
  process.env.BENCH_SUBSCRIPTIONS_ITERATOR_TIMEOUT_MS ?? "20000",
  10,
);
const BENCH_EVENTS_PER_PUBLISHER = Number.parseInt(
  process.env.BENCH_SUBSCRIPTIONS_EVENTS_PER_PUBLISHER ?? "5000",
  10,
);
const BENCH_APPEND_BATCH_SIZE = Number.parseInt(
  process.env.BENCH_SUBSCRIPTIONS_APPEND_BATCH_SIZE ?? "10",
  10,
);
const BENCH_MAX_STEPS = Number.parseInt(process.env.BENCH_SUBSCRIPTIONS_MAX_STEPS ?? "3", 10);

const BASE_LOADS: ReadonlyArray<{ readonly publishers: number; readonly consumers: number }> = [
  { publishers: 1, consumers: 1 },
  { publishers: 2, consumers: 4 },
  { publishers: 4, consumers: 8 },
  { publishers: 8, consumers: 16 },
];

const LOAD_MATRIX: ReadonlyArray<BenchmarkLoad> = BASE_LOADS.slice(
  0,
  Math.max(1, Math.min(BENCH_MAX_STEPS, BASE_LOADS.length)),
).map((load) => ({
  ...load,
  eventsPerPublisher: BENCH_EVENTS_PER_PUBLISHER,
}));

const percentile = (values: ReadonlyArray<number>, p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const perSecond = (count: number, durationMs: number): number =>
  durationMs <= 0 ? 0 : (count * 1000) / durationMs;

const findSlowdownPoint = (rows: ReadonlyArray<BenchmarkMetrics>): BenchmarkMetrics | undefined => {
  let bestDelivery = 0;
  for (const row of rows) {
    bestDelivery = Math.max(bestDelivery, row.deliveryEventsPerSecond);
    if (bestDelivery === 0) continue;

    const droppedFromBest = row.deliveryEventsPerSecond < bestDelivery * 0.8;
    const elevatedLatency = row.appendBatchLatencyP95Ms > rows[0]!.appendBatchLatencyP95Ms * 2;
    if (droppedFromBest && elevatedLatency) return row;
  }
  return undefined;
};

const printBenchmarkTable = (scenarioName: string, rows: ReadonlyArray<BenchmarkMetrics>): void => {
  const output = rows.map((row) => ({
    publishers: row.publishers,
    consumers: row.consumers,
    eventsPerPublisher: row.eventsPerPublisher,
    publishedEvents: row.publishedEvents,
    deliveryEvents: row.deliveryEvents,
    appendBatchSize: row.appendBatchSize,
    appendBatchP95Ms: row.appendBatchLatencyP95Ms.toFixed(2),
    publishMs: row.publishDurationMs.toFixed(1),
    endToEndMs: row.endToEndDurationMs.toFixed(1),
    publishPerSec: row.publishEventsPerSecond.toFixed(1),
    deliveryPerSec: row.deliveryEventsPerSecond.toFixed(1),
  }));

  console.log(`\n[benchmark:${scenarioName}] load matrix`);
  console.table(output);

  const slowdown = findSlowdownPoint(rows);
  if (slowdown !== undefined) {
    console.log(
      `[benchmark:${scenarioName}] slowdown around publishers=${slowdown.publishers}, consumers=${slowdown.consumers}, deliveryPerSec=${slowdown.deliveryEventsPerSecond.toFixed(1)}, appendBatchP95Ms=${slowdown.appendBatchLatencyP95Ms.toFixed(2)}`,
    );
  } else {
    console.log(`[benchmark:${scenarioName}] no clear slowdown point in tested range`);
  }
};

const runPullWebsocketLoad = async (load: BenchmarkLoad): Promise<BenchmarkMetrics> => {
  await using events = await startEventBusTestFixture();
  const httpClient = events.client;
  const pathName = uniquePath("bench-pull-ws");
  const totalEvents = load.publishers * load.eventsPerPublisher;

  const consumers = await Promise.all(
    Array.from({ length: load.consumers }, async () => {
      const fixture = await events.startWebSocketClientFixture();
      const stream = await fixture.client.stream({ path: pathName, live: true });
      return { fixture, iterator: stream[Symbol.asyncIterator]() };
    }),
  );

  const consumerPromises = consumers.map(async ({ iterator }) => {
    let received = 0;
    while (received < totalEvents) {
      const next = await withTimeout(iterator.next(), ITERATOR_TIMEOUT_MS);
      if (next.done) break;
      received += 1;
    }
    await Promise.race([
      Promise.resolve(iterator.return?.()).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    return received;
  });

  const appendLatenciesMs: Array<number> = [];
  const publishStartedAt = performance.now();

  await Promise.all(
    Array.from({ length: load.publishers }, async (_, publisher) => {
      for (
        let sequence = 0;
        sequence < load.eventsPerPublisher;
        sequence += BENCH_APPEND_BATCH_SIZE
      ) {
        const batchSize = Math.min(BENCH_APPEND_BATCH_SIZE, load.eventsPerPublisher - sequence);
        const appendStartedAt = performance.now();
        await httpClient.append({
          path: pathName,
          events: Array.from({ length: batchSize }, (_, batchOffset) => ({
            type: "https://events.iterate.com/events/test/event-recorded",
            payload: { publisher, sequence: sequence + batchOffset },
          })),
        });
        appendLatenciesMs.push(performance.now() - appendStartedAt);
      }
    }),
  );

  const publishDoneAt = performance.now();
  const receivedCounts = await Promise.all(consumerPromises);
  const finishedAt = performance.now();

  for (const consumer of consumers) {
    await disposeWithTimeout(consumer.fixture, 250);
  }

  expect(receivedCounts).toEqual(Array.from({ length: load.consumers }, () => totalEvents));

  const publishedEvents = totalEvents;
  const deliveryEvents = publishedEvents * load.consumers;
  const publishDurationMs = publishDoneAt - publishStartedAt;
  const endToEndDurationMs = finishedAt - publishStartedAt;

  return {
    scenario: "pull-websocket",
    publishers: load.publishers,
    consumers: load.consumers,
    eventsPerPublisher: load.eventsPerPublisher,
    appendBatchSize: BENCH_APPEND_BATCH_SIZE,
    publishedEvents,
    deliveryEvents,
    publishDurationMs,
    endToEndDurationMs,
    appendBatchLatencyP95Ms: percentile(appendLatenciesMs, 95),
    publishEventsPerSecond: perSecond(publishedEvents, publishDurationMs),
    deliveryEventsPerSecond: perSecond(deliveryEvents, endToEndDurationMs),
  };
};

const runPushWebhookLoad = async (load: BenchmarkLoad): Promise<BenchmarkMetrics> => {
  await using events = await startEventBusTestFixture();
  const publisherClient = events.client;
  const pathName = uniquePath("bench-push-webhook");
  const totalEvents = load.publishers * load.eventsPerPublisher;
  const countPublishedEvents = (callback: WebhookFixture): number =>
    callback.bodies.filter(
      (body) => body["type"] === "https://events.iterate.com/events/test/event-recorded",
    ).length;

  const callbacks: Array<WebhookFixture> = [];
  try {
    for (let index = 0; index < load.consumers; index += 1) {
      callbacks.push(
        await startWebhookFixture({}, { timeoutMs: BENCH_TEST_TIMEOUT_MS, intervalMs: 10 }),
      );
    }

    for (let index = 0; index < callbacks.length; index += 1) {
      await appendSubscriptionRegistration(publisherClient, {
        path: pathName,
        callbackURL: callbacks[index]!.url,
        subscriptionSlug: `bench-consumer-${index}`,
        subscriptionType: "webhook",
      });
    }

    const baselineBodies = callbacks.map((callback) => countPublishedEvents(callback));
    const appendLatenciesMs: Array<number> = [];
    const publishStartedAt = performance.now();

    await Promise.all(
      Array.from({ length: load.publishers }, async (_, publisher) => {
        const client = events.createHttpClient();
        for (
          let sequence = 0;
          sequence < load.eventsPerPublisher;
          sequence += BENCH_APPEND_BATCH_SIZE
        ) {
          const batchSize = Math.min(BENCH_APPEND_BATCH_SIZE, load.eventsPerPublisher - sequence);
          const appendStartedAt = performance.now();
          await client.append({
            path: pathName,
            events: Array.from({ length: batchSize }, (_, batchOffset) => ({
              type: "https://events.iterate.com/events/test/event-recorded",
              payload: { publisher, sequence: sequence + batchOffset },
            })),
          });
          appendLatenciesMs.push(performance.now() - appendStartedAt);
        }
      }),
    );

    const publishDoneAt = performance.now();

    await Promise.all(
      callbacks.map((callback, index) =>
        waitUntil(
          () => countPublishedEvents(callback) - (baselineBodies[index] ?? 0) >= totalEvents,
          {
            timeoutMs: BENCH_TEST_TIMEOUT_MS,
            intervalMs: 10,
            timeoutMessage: `Timed out waiting for consumer ${index} to receive ${totalEvents} events`,
          },
        ),
      ),
    );

    const finishedAt = performance.now();
    const receivedCounts = callbacks.map(
      (callback, index) => countPublishedEvents(callback) - (baselineBodies[index] ?? 0),
    );

    expect(receivedCounts).toEqual(Array.from({ length: load.consumers }, () => totalEvents));

    const publishedEvents = totalEvents;
    const deliveryEvents = publishedEvents * load.consumers;
    const publishDurationMs = publishDoneAt - publishStartedAt;
    const endToEndDurationMs = finishedAt - publishStartedAt;

    return {
      scenario: "push-webhook",
      publishers: load.publishers,
      consumers: load.consumers,
      eventsPerPublisher: load.eventsPerPublisher,
      appendBatchSize: BENCH_APPEND_BATCH_SIZE,
      publishedEvents,
      deliveryEvents,
      publishDurationMs,
      endToEndDurationMs,
      appendBatchLatencyP95Ms: percentile(appendLatenciesMs, 95),
      publishEventsPerSecond: perSecond(publishedEvents, publishDurationMs),
      deliveryEventsPerSecond: perSecond(deliveryEvents, endToEndDurationMs),
    };
  } finally {
    await Promise.all(callbacks.map((callback) => disposeWithTimeout(callback, 1_000)));
  }
};

describe("Subscriptions benchmark", () => {
  test(
    "pull websocket fan-out benchmark (publishers x consumers x volume)",
    async () => {
      const rows: Array<BenchmarkMetrics> = [];

      for (const load of LOAD_MATRIX) {
        rows.push(await runPullWebsocketLoad(load));
      }

      printBenchmarkTable("pull-websocket", rows);
      expect(rows.length).toBeGreaterThan(0);
    },
    BENCH_TEST_TIMEOUT_MS,
  );

  test(
    "push webhook fan-out benchmark (publishers x consumers x volume)",
    async () => {
      const rows: Array<BenchmarkMetrics> = [];

      for (const load of LOAD_MATRIX) {
        rows.push(await runPushWebhookLoad(load));
      }

      printBenchmarkTable("push-webhook", rows);
      expect(rows.length).toBeGreaterThan(0);
    },
    BENCH_TEST_TIMEOUT_MS,
  );
});
