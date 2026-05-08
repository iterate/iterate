import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamPath,
  type Event,
} from "@iterate-com/shared/streams/types";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  defaultE2ENamespace,
  requireEventsBaseUrl,
} from "../helpers.ts";
import { E2E_APPEND_CHAIN_TICK_TYPE } from "../../src/durable-objects/e2e-append-chain-types.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const historyIdleTimeoutMs = 250;
const pollIntervalMs = 100;
const chainWaitTimeoutMs = 30_000;
const testTimeoutMs = 45_000;

describe.sequential("events callable subscriber e2e", () => {
  test(
    "a callable subscriber can append a bounded chain back to the same deployed stream without hanging the caller",
    async () => {
      /**
       * This network e2e test is the deployed counterpart to the Miniflare
       * worker test in src/durable-objects/callable-subscriber.e2e.test.ts.
       *
       * The important production call graph is:
       *
       *   events worker append API
       *     -> StreamDurableObject.append(tick 1)
       *       -> external subscriber processor dispatches Workers RPC callable
       *         -> E2EAppendChainSubscriber.afterAppend(tick 1)
       *           -> this.env.STREAM.get(...).append(tick 2)
       *             -> StreamDurableObject.afterAppend(tick 2)
       *               -> dispatches the same callable subscriber again
       *                 -> E2EAppendChainSubscriber.afterAppend(tick 2)
       *                   -> this.env.STREAM.get(...).append(tick 3)
       *                     -> ...
       *
       * This is deliberately not testing the subscriber DO in isolation. The
       * bug only appears when Cloudflare's deployed runtime sees the stream DO
       * and callable subscriber recursively call each other through real Worker
       * RPC/DO stubs. Local Miniflare currently completes this chain even at
       * high counts, so the preview run is the authority for the platform
       * depth behavior.
       *
       * Failure mode before the alarm fix:
       *
       * - the stream contains the first N tick events;
       * - N stays below `max` because the synchronous callable subscriber chain
       *   exhausts or stalls the deployed Worker-to-Worker call stack;
       * - callers higher up the stack observe either a serialized
       *   "Subrequest depth limit exceeded" error or a timeout waiting for a
       *   completion event that never arrives.
       *
       * Desired behavior after the alarm fix:
       *
       * - callable subscriber delivery is queued onto the stream DO alarm;
       * - each alarm turn runs in a fresh Durable Object event;
       * - the final stream history contains exactly tick counts 1..max.
       */
      const path = StreamPath.parse(`/e2e/callable-chain/${randomUUID().slice(0, 8)}`);
      const chainId = randomUUID();
      const max = 200;

      await app.append({
        path,
        event: {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          payload: {
            slug: `e2e-callable-chain:${chainId}`,
            type: "callable",
            callable: {
              type: "workers-rpc",
              via: {
                type: "env-binding",
                bindingType: "durable-object-namespace",
                bindingName: "E2E_APPEND_CHAIN_SUBSCRIBER",
                durableObject: { name: chainId },
              },
              rpcMethod: "afterAppend",
              argsMode: "object",
            },
          },
        },
      });

      await app.append({
        path,
        event: {
          type: E2E_APPEND_CHAIN_TICK_TYPE,
          idempotencyKey: `e2e-callable-append-chain:${chainId}:1`,
          payload: {
            chainId,
            count: 1,
            max,
            mode: "timeout",
            namespace: defaultE2ENamespace,
            streamPath: path,
          },
        },
      });

      const ticks = await waitForCallableChainTicks({
        chainId,
        max,
        path,
      });

      expect(ticks.map((event) => getCount(event))).toEqual(
        Array.from({ length: max }, (_, index) => index + 1),
      );
    },
    testTimeoutMs,
  );

  test(
    "a callable subscriber can append recursively without surfacing the deployed subrequest-depth exception",
    async () => {
      const path = StreamPath.parse(`/e2e/callable-chain-error/${randomUUID().slice(0, 8)}`);
      const chainId = randomUUID();
      const max = 200;

      await app.append({
        path,
        event: {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          payload: {
            slug: `e2e-callable-chain:${chainId}`,
            type: "callable",
            callable: {
              type: "workers-rpc",
              via: {
                type: "env-binding",
                bindingType: "durable-object-namespace",
                bindingName: "E2E_APPEND_CHAIN_SUBSCRIBER",
                durableObject: { name: chainId },
              },
              rpcMethod: "afterAppend",
              argsMode: "object",
            },
          },
        },
      });

      await app.append({
        path,
        event: {
          type: E2E_APPEND_CHAIN_TICK_TYPE,
          idempotencyKey: `e2e-callable-append-chain:${chainId}:1`,
          payload: {
            chainId,
            count: 1,
            max,
            mode: "record-error",
            namespace: defaultE2ENamespace,
            streamPath: path,
          },
        },
      });

      const ticks = await waitForCallableChainTicks({
        chainId,
        failOnSubscriberError: true,
        max,
        path,
      });

      expect(ticks.map((event) => getCount(event))).toEqual(
        Array.from({ length: max }, (_, index) => index + 1),
      );
    },
    testTimeoutMs,
  );
});

async function waitForCallableChainTicks(args: {
  chainId: string;
  failOnSubscriberError?: boolean;
  max: number;
  path: StreamPath;
}) {
  const deadline = Date.now() + chainWaitTimeoutMs;
  let lastTicks: Event[] = [];

  while (Date.now() < deadline) {
    const ticks = (await collectEvents(args.path)).filter(
      (event) =>
        event.type === E2E_APPEND_CHAIN_TICK_TYPE &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "chainId" in event.payload &&
        event.payload.chainId === args.chainId,
    );

    if (ticks.length === args.max) {
      return ticks;
    }
    lastTicks = ticks;

    if (args.failOnSubscriberError === true) {
      const status = await getSubscriberStatus(args.chainId);
      if (status.lastError != null) {
        throw new Error(
          `Callable subscriber recorded ${status.lastError.name} after tick ${status.lastError.count}: ${status.lastError.message}`,
        );
      }
    }

    await delay(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${args.max} callable subscriber chain ticks in ${args.path}; observed ${lastTicks.length} ticks with counts [${lastTicks
      .map((event) => getCount(event))
      .join(", ")}]`,
  );
}

async function getSubscriberStatus(chainId: string) {
  const response = await app.fetch(
    `/__e2e/append-chain-subscriber/${encodeURIComponent(chainId)}/status`,
  );
  if (!response.ok) {
    throw new Error(`Subscriber status returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as {
    lastError: null | {
      count: number;
      message: string;
      name: string;
    };
  };
}

async function collectEvents(path: StreamPath) {
  return await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      beforeOffset: "end",
    }),
    idleMs: historyIdleTimeoutMs,
  });
}

function getCount(event: Event) {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    !("count" in event.payload) ||
    typeof event.payload.count !== "number"
  ) {
    throw new Error(`Tick event ${event.offset} did not have a numeric count payload.`);
  }

  return event.payload.count;
}
