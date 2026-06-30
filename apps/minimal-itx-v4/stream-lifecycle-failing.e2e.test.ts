import { expect, test } from "vitest";
import { withItxSession } from "./test-helpers.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";
import type { Stream, StreamEvent } from "./src/types.ts";

type RuntimeConnection = {
  subscriptionType?: "configured" | "ephemeral";
  startedAt?: string;
};

type ReducedConnection = {
  subscriptionType?: "configured" | "ephemeral";
  subscriber?: {
    description?: string;
  };
};

type StreamRuntimeState = {
  coreProcessorState: {
    connectionsByKey?: Record<string, ReducedConnection>;
    configuredSubscribersByKey?: Record<string, unknown>;
  };
  runtime: {
    connections: Record<string, RuntimeConnection>;
  };
};

const WAIT_FOR_EVENT_TYPE = "events.iterate.test/lifecycle-wait-never";

test.skip("configured processor subscriptions are recorded as configured runtime connections", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `lifecycle-configured-${marker}` });
  using stream = project.streams.get("/");

  const { keys, state } = await waitForConfiguredProcessorConnections(stream);

  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(state.runtime.connections[key]?.subscriptionType).toBe("configured");
    expect(state.coreProcessorState.connectionsByKey?.[key]?.subscriptionType).toBe("configured");
  }
});

test.skip("stream idle teardown severs configured processor subscriptions", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `lifecycle-idle-${marker}` });
  using stream = project.streams.get("/");

  const { keys } = await waitForConfiguredProcessorConnections(stream);

  await forceStreamIdleTeardown(stream);

  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return keys.every((key) => state.runtime.connections[key] === undefined);
    },
    {
      description: `configured processor connections to be severed by idle teardown (${keys.join(", ")})`,
      timeoutMs: 1_500,
    },
  );

  const events = await stream.getEvents({ afterOffset: 0 });
  for (const key of keys) {
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            reason: "idle",
            subscriptionKey: key,
          }),
          type: "events.iterate.com/stream/subscriber-disconnected",
        }),
      ]),
    );
  }
});

test.skip("append after idle teardown re-wakes configured subscriber from its checkpoint", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `lifecycle-redial-${marker}` });
  using stream = project.streams.get("/");

  const { keys } = await waitForConfiguredProcessorConnections(stream);

  await forceStreamIdleTeardown(stream);

  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return keys.every((key) => state.runtime.connections[key] === undefined);
    },
    {
      description: `configured processor connections to be absent before re-wake (${keys.join(", ")})`,
      timeoutMs: 1_500,
    },
  );

  await stream.append({
    type: "events.iterate.test/lifecycle-redial-trigger",
    payload: { marker },
  });

  const { state } = await waitForConfiguredProcessorConnections(stream, { expectedKeys: keys });
  for (const key of keys) {
    expect(state.runtime.connections[key]?.subscriptionType).toBe("configured");
  }
});

test.skip("closing a Cap'n Web session without unsubscribe removes its stream subscription", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/lifecycle-session-close-${marker}`;
  const subscriptionKey = `lifecycle-session-close-${marker}`;

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = observerItx.projects.create({ slug: `lifecycle-session-close-${marker}` });
  const { projectId } = await project.describe();
  using observerStream = project.streams.get(streamPath);

  const delivered: StreamEvent[] = [];
  const subscriberSession = withItxSession();
  try {
    const subscriberItx = subscriberSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const subscriberProject = subscriberItx.projects.get(projectId);
    const subscriberStream = subscriberProject.streams.get(streamPath);
    const subscription = await subscriberStream.subscribe({
      processEventBatch: (batch) => {
        delivered.push(...batch.events);
      },
      subscriptionKey,
    });
    expect(await subscription.subscriptionKey).toBe(subscriptionKey);

    await waitForRuntimeConnection(observerStream, subscriptionKey);

    disposeRpc(subscriberSession);

    await waitForCondition(
      async () => {
        const state = asStreamRuntimeState(await observerStream.runtimeState());
        return state.runtime.connections[subscriptionKey] === undefined;
      },
      {
        description: "closed Cap'n Web session to remove its stream subscription",
        timeoutMs: 2_000,
      },
    );

    await observerStream.append({
      type: "events.iterate.test/lifecycle-session-close",
      payload: { marker },
    });
    await delay(250);
    expect(delivered).toEqual([]);
  } finally {
    disposeRpc(subscriberSession);
  }
});

test.skip("dropping a WebSocket waitForEvent caller cleans up the internal waitForEvent subscription", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/lifecycle-wait-for-event-${marker}`;

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = observerItx.projects.create({ slug: `lifecycle-wait-${marker}` });
  const { projectId } = await project.describe();
  using observerStream = project.streams.get(streamPath);

  const waiterSession = withItxSession();
  try {
    const waiterItx = waiterSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const waiterProject = waiterItx.projects.get(projectId);
    const waiterStream = waiterProject.streams.get(streamPath);
    const pending = waiterStream.waitForEvent({
      eventTypes: [WAIT_FOR_EVENT_TYPE],
      timeoutMs: 60_000,
    });
    void pending.catch(() => undefined);

    const waitForEventKey = await waitForWaitForEventConnection(observerStream);

    disposeRpc(waiterSession);

    await waitForCondition(
      async () => {
        const state = asStreamRuntimeState(await observerStream.runtimeState());
        return state.coreProcessorState.connectionsByKey?.[waitForEventKey] === undefined;
      },
      {
        description: "closed Cap'n Web session to remove its waitForEvent subscription",
        timeoutMs: 2_000,
      },
    );
  } finally {
    disposeRpc(waiterSession);
  }
});

async function waitForConfiguredProcessorConnections(
  stream: Stream,
  opts: { expectedKeys?: readonly string[] } = {},
): Promise<{ keys: string[]; state: StreamRuntimeState }> {
  let latest: StreamRuntimeState | undefined;
  await waitForCondition(
    async () => {
      latest = asStreamRuntimeState(await stream.runtimeState());
      const keys =
        opts.expectedKeys === undefined ? configuredSubscriptionKeys(latest) : opts.expectedKeys;
      return (
        keys.length > 0 &&
        keys.every(
          (key) =>
            latest!.runtime.connections[key] !== undefined &&
            latest!.coreProcessorState.connectionsByKey?.[key] !== undefined,
        )
      );
    },
    { description: "configured processor connections to become live" },
  );

  const state = latest!;
  return {
    keys:
      opts.expectedKeys === undefined ? configuredSubscriptionKeys(state) : [...opts.expectedKeys],
    state,
  };
}

async function waitForRuntimeConnection(
  stream: Stream,
  subscriptionKey: string,
): Promise<RuntimeConnection> {
  let connection: RuntimeConnection | undefined;
  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      connection = state.runtime.connections[subscriptionKey];
      return connection !== undefined;
    },
    { description: `runtime connection "${subscriptionKey}" to become live` },
  );
  return connection!;
}

async function waitForWaitForEventConnection(stream: Stream): Promise<string> {
  let key: string | undefined;
  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      key = Object.entries(state.coreProcessorState.connectionsByKey ?? {}).find(
        ([, connection]) => connection.subscriber?.description === "waitForEvent",
      )?.[0];
      return key !== undefined;
    },
    { description: "waitForEvent internal subscription to become visible" },
  );
  return key!;
}

async function forceStreamIdleTeardown(stream: Stream): Promise<void> {
  // Test-only operator path: exercise the idle teardown behavior without waiting
  // for the production five-minute timer.
  await (
    stream as unknown as {
      durableObjectStub: {
        runIdleTeardownNow(): Promise<void> | void;
      };
    }
  ).durableObjectStub.runIdleTeardownNow();
}

function configuredSubscriptionKeys(state: StreamRuntimeState): string[] {
  return Object.keys(state.coreProcessorState.configuredSubscribersByKey ?? {});
}

function asStreamRuntimeState(value: unknown): StreamRuntimeState {
  return value as StreamRuntimeState;
}

function disposeRpc(value: unknown): void {
  (value as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  opts: { description: string; intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${opts.description}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
