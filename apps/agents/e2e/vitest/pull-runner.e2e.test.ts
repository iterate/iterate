import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  Event,
  type EventInput,
  type Event as EventsEvent,
  type StreamPath,
} from "@iterate-com/shared/streams/types";
import type { ProcessorStreamApi } from "@iterate-com/shared/stream-processors";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/legacy-codemode/contract";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/legacy-codemode/implementation";
import { setupE2E, type E2EContext } from "../test-support/e2e-test.ts";
import {
  createMemoryPullProcessorStorage,
  runPullProcessor,
} from "../../src/stream-processors/pull-runner.ts";

test(
  "polling pull runner catches up from real Events history and appends derived codemode events",
  { tags: ["live-internet"], timeout: 120_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();
    const abortController = new AbortController();
    const subscriptionStarted = createDeferred<void>();
    const storage = createMemoryPullProcessorStorage({
      contract: CodemodeProcessorContract,
    });
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    const runnerPromise = runPullProcessor({
      processor,
      storage,
      streamApi: createPollingEventsStreamApi({
        e2e,
        streamPath,
        onSubscribeStarted: () => subscriptionStarted.resolve(),
      }),
      signal: abortController.signal,
    });

    await Promise.race([subscriptionStarted.promise, runnerPromise]);

    await e2e.events.client.append({
      path: streamPath,
      event: {
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: "```js\nasync () => {\n  return 7;\n}\n```",
        },
      },
    });

    const block = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "events.iterate.com/codemode/block-added",
      { timeoutMs: 45_000, pollMs: 250 },
    );

    expect(block.payload).toEqual({
      script: "async () => {\n  return 7;\n}",
    });
    expect(block.idempotencyKey).toContain("stream-processor:codemode:derived:");

    abortController.abort();
    await expect(resolveWithin(runnerPromise, 5_000)).resolves.toBeDefined();

    const storedState = storage.get();
    expect(storedState?.hasCompletedFirstAttach).toBe(true);
    expect(storedState?.reducedThroughOffset).toBeGreaterThanOrEqual(2);
  },
);

test(
  "oRPC stream pull runner catches up then consumes live Events subscription",
  { tags: ["live-internet"], timeout: 120_000 },
  async (ctx) => {
    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();
    const abortController = new AbortController();
    const subscriptionStarted = createDeferred<void>();
    const storage = createMemoryPullProcessorStorage({
      contract: CodemodeProcessorContract,
    });
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { from: "orpc-stream-fake-executor" } }),
      env: {},
    });

    const runnerPromise = runPullProcessor({
      processor,
      storage,
      streamApi: createOrpcStreamEventsStreamApi({
        e2e,
        streamPath,
        onSubscribeStarted: () => subscriptionStarted.resolve(),
      }),
      signal: abortController.signal,
    });

    await Promise.race([subscriptionStarted.promise, runnerPromise]);

    await e2e.events.client.append({
      path: streamPath,
      event: {
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: "```js\nasync () => {\n  return 11;\n}\n```",
        },
      },
    });

    const result = await e2e.events.waitForEvent(
      streamPath,
      (event) => event.type === "events.iterate.com/codemode/result-added",
      { timeoutMs: 45_000, pollMs: 250 },
    );

    expect(result.payload).toMatchObject({
      result: { from: "orpc-stream-fake-executor" },
    });

    abortController.abort();
    await expect(resolveWithin(runnerPromise, 5_000)).resolves.toBeDefined();

    const storedState = storage.get();
    expect(storedState?.hasCompletedFirstAttach).toBe(true);
    expect(storedState?.reducedThroughOffset).toBeGreaterThanOrEqual(2);
  },
);

function createPollingEventsStreamApi(args: {
  e2e: E2EContext;
  streamPath: StreamPath;
  onSubscribeStarted(): void;
}): ProcessorStreamApi<typeof CodemodeProcessorContract> {
  return {
    async append({ event, streamPath }) {
      const result = await args.e2e.events.client.append({
        path: resolveStreamPath({
          boundStreamPath: args.streamPath,
          streamPath,
        }),
        event: event as EventInput,
      });
      return Event.parse(result.event);
    },

    async read(readArgs) {
      return await readEvents({
        e2e: args.e2e,
        streamPath: resolveStreamPath({
          boundStreamPath: args.streamPath,
          streamPath: readArgs?.streamPath,
        }),
        afterOffset: toEventsApiOffset(readArgs?.afterOffset ?? "start"),
        beforeOffset: readArgs?.beforeOffset ?? "end",
      });
    },

    subscribe: async function* (subscribeArgs = {}) {
      args.onSubscribeStarted();
      let afterOffset = subscribeArgs.afterOffset ?? "start";

      while (!subscribeArgs.signal?.aborted) {
        const events = await readEvents({
          e2e: args.e2e,
          streamPath: resolveStreamPath({
            boundStreamPath: args.streamPath,
            streamPath: subscribeArgs.streamPath,
          }),
          afterOffset: toEventsApiOffset(afterOffset),
          beforeOffset: "end",
        });

        for (const event of events) {
          if (subscribeArgs.signal?.aborted) {
            return;
          }

          yield event;
          afterOffset = event.offset;
        }

        await sleepUnlessAborted({
          milliseconds: events.length === 0 ? 250 : 2_000,
          signal: subscribeArgs.signal,
        });
      }
    },
  };
}

function createOrpcStreamEventsStreamApi(args: {
  e2e: E2EContext;
  streamPath: StreamPath;
  onSubscribeStarted(): void;
}): ProcessorStreamApi<typeof CodemodeProcessorContract> {
  return {
    async append({ event, streamPath }) {
      const result = await args.e2e.events.client.append({
        path: resolveStreamPath({
          boundStreamPath: args.streamPath,
          streamPath,
        }),
        event: event as EventInput,
      });
      return Event.parse(result.event);
    },

    async read(readArgs) {
      return await readEvents({
        e2e: args.e2e,
        streamPath: resolveStreamPath({
          boundStreamPath: args.streamPath,
          streamPath: readArgs?.streamPath,
        }),
        afterOffset: toEventsApiOffset(readArgs?.afterOffset ?? "start"),
        beforeOffset: readArgs?.beforeOffset ?? "end",
      });
    },

    subscribe: async function* (subscribeArgs = {}) {
      const stream = await args.e2e.events.client.stream(
        {
          path: resolveStreamPath({
            boundStreamPath: args.streamPath,
            streamPath: subscribeArgs.streamPath,
          }),
          afterOffset: toEventsApiOffset(subscribeArgs.afterOffset ?? "start"),
        },
        { signal: subscribeArgs.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();
      args.onSubscribeStarted();

      try {
        while (true) {
          const next = await Promise.race([
            iterator.next(),
            waitForAbort(subscribeArgs.signal).then(() => ({
              done: true as const,
              value: undefined,
            })),
          ]);

          if (next.done) {
            return;
          }

          yield Event.parse(next.value);
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}

async function readEvents(args: {
  e2e: E2EContext;
  streamPath: StreamPath;
  afterOffset: number | "start" | "end";
  beforeOffset: number | "start" | "end";
}): Promise<EventsEvent[]> {
  const stream = await args.e2e.events.client.stream({
    path: args.streamPath,
    afterOffset: args.afterOffset,
    beforeOffset: args.beforeOffset,
  });
  const events: EventsEvent[] = [];

  for await (const value of stream) {
    events.push(Event.parse(value));
  }

  return events;
}

function resolveStreamPath(args: {
  boundStreamPath: StreamPath;
  streamPath: string | undefined;
}): StreamPath {
  if (args.streamPath == null || args.streamPath.length === 0) {
    return args.boundStreamPath;
  }

  if (args.streamPath.startsWith("/")) {
    return args.streamPath as StreamPath;
  }

  return `${args.boundStreamPath.replace(/\/+$/, "")}/${args.streamPath}` as StreamPath;
}

function toEventsApiOffset(offset: number | "start" | "end"): number | "start" | "end" {
  return typeof offset === "number" && offset <= 0 ? "start" : offset;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function sleepUnlessAborted(args: { milliseconds: number; signal?: AbortSignal }) {
  try {
    await delay(args.milliseconds, undefined, { signal: args.signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal == null) {
    return await new Promise(() => {});
  }

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`Promise did not resolve within ${timeoutMs}ms`);
    }),
  ]);
}
