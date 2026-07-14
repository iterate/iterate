import type { ProcessEventBatch, StreamSubscriptionHandle } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";

const DEFAULT_HEARTBEAT_MS = 1_000;

type WaitForStreamEventInput = {
  afterOffset?: number;
  eventTypes?: readonly string[];
  predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
  timeoutMs: number;
};

export type SubscribeForStreamWait = (args: {
  subscriptionKey: string;
  processEventBatch: ProcessEventBatch;
  replayAfterOffset?: number;
  eventTypes?: readonly string[];
  subscriber: { description: string };
}) => Promise<StreamSubscriptionHandle>;

/**
 * Push-based one-shot wait with reset recovery.
 *
 * The heartbeat is deliberately a real RPC call. Besides detecting a dead
 * Stream incarnation, that I/O gives the fronting Worker a fresh clock sample;
 * elapsed Worker time alone is not a reliable liveness signal on Cloudflare.
 */
export async function waitForStreamEvent(
  subscribe: SubscribeForStreamWait,
  args: WaitForStreamEventInput,
  options: {
    heartbeatMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<StreamEvent> {
  validateInput(args);

  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const predicate = args.predicate ?? (() => true);
  const found = Promise.withResolvers<StreamEvent>();
  const subscriptionKey = `waitForEvent:${crypto.randomUUID()}`;

  let activeGeneration = 0;
  let activeHandle: StreamSubscriptionHandle | undefined;
  let replayAfterOffset = args.afterOffset;
  let scannedOffset = args.afterOffset ?? 0;
  let scan: Promise<void> = Promise.resolve();
  let settled = false;
  let seenCount = 0;
  const recentTypes: string[] = [];

  const settle = (outcome: { event: StreamEvent } | { error: unknown }): void => {
    if (settled) return;
    settled = true;
    if ("event" in outcome) found.resolve(outcome.event);
    else found.reject(outcome.error);
  };

  const arm = async (): Promise<void> => {
    const generation = ++activeGeneration;
    const handle = await subscribe({
      subscriptionKey,
      eventTypes: args.eventTypes,
      replayAfterOffset,
      subscriber: { description: "waitForEvent" },
      processEventBatch: (batch) => {
        if (settled || generation !== activeGeneration) return;

        // Advance synchronously, before an async predicate can yield. A reset
        // then replays only delivery the Worker has already received.
        replayAfterOffset = Math.max(replayAfterOffset ?? 0, batch.deliveryThroughOffset);
        scan = scan.then(async () => {
          for (const event of batch.events) {
            if (settled) return;
            if (event.offset <= scannedOffset) continue;
            scannedOffset = event.offset;
            seenCount += 1;
            recentTypes.push(event.type);
            if (recentTypes.length > 20) recentTypes.shift();
            if (await predicate(event)) {
              settle({ event });
              return;
            }
          }
        });
        void scan.catch((error: unknown) => settle({ error }));
      },
    });

    if (settled || generation !== activeGeneration) {
      closeSubscription(handle);
      return;
    }
    activeHandle = handle;
  };

  const heartbeat = async (): Promise<void> => {
    await arm();
    while (!settled) {
      await sleep(heartbeatMs);
      if (settled) return;

      const handle = activeHandle;
      if (handle === undefined) {
        try {
          await arm();
        } catch {
          // The subscribe attempt itself is network I/O. Retry until the
          // caller's timeout wins rather than turning a reset into a failure.
        }
        continue;
      }

      let live = false;
      try {
        live = (await handle.ping()) === true;
      } catch {
        // A reset rejects calls on the old RpcTarget.
      }
      if (settled || live) continue;

      activeHandle = undefined;
      activeGeneration += 1;
      closeSubscription(handle);
      try {
        await arm();
      } catch {
        // The next heartbeat retries from the same delivered cursor.
      }
    }
  };

  const timer = setTimeout(() => {
    settle({
      error: new Error(
        `Timed out waiting for stream event after ${args.timeoutMs}ms ` +
          `(saw ${seenCount} events; recent types: ${recentTypes.join(", ") || "none"}).`,
      ),
    });
  }, args.timeoutMs);
  void heartbeat().catch((error: unknown) => settle({ error }));

  try {
    return await found.promise;
  } finally {
    clearTimeout(timer);
    settled = true;
    activeGeneration += 1;
    if (activeHandle !== undefined) closeSubscription(activeHandle);
  }
}

function validateInput(args: WaitForStreamEventInput): void {
  if (args.eventTypes === undefined && args.predicate === undefined) {
    throw new Error("waitForEvent requires eventTypes or predicate.");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("waitForEvent timeoutMs must be a positive number.");
  }
  if (
    args.afterOffset !== undefined &&
    (!Number.isInteger(args.afterOffset) || args.afterOffset < 0)
  ) {
    throw new Error("waitForEvent afterOffset must be a non-negative integer.");
  }
}

function closeSubscription(handle: StreamSubscriptionHandle): void {
  try {
    handle.unsubscribe();
  } catch {
    // A dead incarnation cannot be asked to clean itself up.
  }
  try {
    handle[Symbol.dispose]();
  } catch {
    // Releasing an already-broken RPC capability is best-effort.
  }
}
