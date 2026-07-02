import { expect, test } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../src/types.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

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

// These tests are intentionally about subscription lifecycle policy, not about
// the old inbound/outbound transport direction. The current model has two
// subscription types:
// - configured: durable desired state in `configuredSubscribersByKey`; the
//   stream may drop the live callback while idle because it can wake the target
//   again from the stored configuration.
// - ephemeral: a direct caller supplied a live callback via `subscribe()`; the
//   stream must keep it until unsubscribe, RPC break, or session end because
//   there is no durable wakeup path.
//
// Several of these started life as failing regression tests for streams keeping
// Durable Objects alive through retained callback stubs. The now-active tests
// prove the configured path is teardownable and re-wakeable, while direct
// Cap'n Web subscriptions are cleaned up when their session is disposed.
test("configured processor subscriptions are recorded as configured runtime connections", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
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

test("ephemeral subscriptions cannot reuse a configured subscription key", async () => {
  // A subscription key that exists in `configuredSubscribersByKey` is not just a
  // caller-chosen label; it is the durable identity of a wakeable subscriber.
  // Allowing a direct `subscribe()` call to reuse that key would let an
  // ephemeral callback replace or "steal" traffic from the configured
  // subscriber, and it would make idle teardown ambiguous: the same key would
  // sometimes be safe to drop/re-wake and sometimes not. This test ties to the
  // guard in `StreamDurableObject.subscribe(...)` that rejects configured keys
  // on the public ephemeral path.
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `lifecycle-key-reserved-${marker}` });
  using stream = project.streams.get("/");

  const { keys } = await waitForConfiguredProcessorConnections(stream);
  const [subscriptionKey] = keys;
  if (subscriptionKey === undefined) {
    throw new Error("expected project bootstrap to configure at least one subscriber");
  }

  await expect(async () => {
    const handle = await stream.subscribe({
      processEventBatch: () => undefined,
      subscriptionKey,
    });
    await handle.unsubscribe();
  }).rejects.toThrow(/reserved for a configured subscriber/);
});

test("configured durable object subscribers must target the stream project", async () => {
  // This pins the important pre-commit rule for project-scoped streams: a
  // configured Durable Object subscriber may only name a Durable Object address
  // with the same projectId as the stream. If append accepted this event and the
  // wake side effect merely failed later, the stream would still retain a bad
  // durable desired-state record and keep trying to wake it on future appends.
  // The final `expectNoSubscriptionConfiguredEvent(...)` assertion is the
  // critical part: it proves rejection happened before the event was committed.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-cross-project-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `configured-cross-project-${marker}` });
  const { projectId } = await project.describe();
  using stream = project.streams.get(`/configured-cross-project-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        subscriber: {
          address: {
            path: "/",
            projectId: `${projectId}-other`,
            props: {},
          },
          type: "repo",
        },
      }),
    ),
  ).rejects.toThrow(/does not match stream projectId/);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("global streams reject project-scoped configured durable object subscribers", async () => {
  // The same invariant applies to deployment-wide/global streams. A stream with
  // `projectId: null` may only configure subscribers whose Durable Object
  // address also has `projectId: null`; it must not become a global registry that
  // can wake arbitrary project Durable Objects. This covers the null-project
  // branch of the same append-time validation as the previous test.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-global-cross-project-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using stream = itx.streams.get(`/configured-global-cross-project-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        subscriber: {
          address: {
            path: "/",
            projectId: `prj_${marker}`,
            props: {},
          },
          type: "repo",
        },
      }),
    ),
  ).rejects.toThrow(/does not match stream projectId/);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("global streams reject configured worker subscribers", async () => {
  // Worker subscribers are slightly different from Durable Object subscribers:
  // the event stores a DynamicWorkerRef, not a Durable Object address. The wake path
  // scopes that DynamicWorkerRef with the stream's own projectId, so project streams
  // are safe by construction. A global stream has no projectId to provide, so
  // accepting this event would create durable desired state that can never be
  // woken safely. This test makes that rejection happen during append, before
  // `configuredSubscribersByKey` is updated.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-global-worker-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using stream = itx.streams.get(`/configured-global-worker-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        subscriber: {
          type: "worker",
          workerRef: {
            path: "/subscribers/noop",
            source: {
              mainModule: "index.ts",
              modules: {
                "index.ts": "export default { wakeStreamSubscriber() {} };",
              },
              type: "inline",
            },
            type: "stateless",
          },
        },
      }),
    ),
  ).rejects.toThrow(/configured worker subscribers require a project-scoped stream/);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("stream idle teardown severs configured processor subscriptions", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
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

test("append after idle teardown re-wakes configured subscriber from its checkpoint", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
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

test("closing a Cap'n Web session without unsubscribe removes its stream subscription", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/lifecycle-session-close-${marker}`;
  const subscriptionKey = `lifecycle-session-close-${marker}`;

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = observerItx.projects.create({ slug: `lifecycle-session-close-${marker}` });
  const { projectId } = await project.describe();
  using observerStream = project.streams.get(streamPath);

  const delivered: StreamEvent[] = [];
  const subscriberSession = withItxSession();
  try {
    const subscriberItx = subscriberSession.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
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
    delivered.length = 0;

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
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = observerItx.projects.create({ slug: `lifecycle-wait-${marker}` });
  const { projectId } = await project.describe();
  using observerStream = project.streams.get(streamPath);

  const waiterSession = withItxSession();
  try {
    const waiterItx = waiterSession.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
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

function subscriptionConfiguredEvent(input: {
  subscriber: Record<string, unknown>;
  subscriptionKey: string;
}): StreamEventInput {
  // These tests hand-author the public event instead of using the bootstrap
  // helper on purpose. The bug class we care about is "a caller with append
  // authority can put an unsafe configured subscriber into durable stream
  // state." If we only tested helper-generated events, we would miss that the
  // Stream Durable Object itself is the trust boundary.
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: input.subscriptionKey,
      subscriber: input.subscriber,
    },
  };
}

async function expectNoSubscriptionConfiguredEvent(
  stream: Stream,
  subscriptionKey: string,
): Promise<void> {
  // Rejecting during the later wake side effect is not enough; by then the
  // event is already durable and reduced into `configuredSubscribersByKey`.
  // Every target-safety test calls this helper to assert the append gate failed
  // before the bad desired-state fact reached storage.
  const events = await stream.getEvents({ afterOffset: 0 });
  expect(events).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ subscriptionKey }),
        type: "events.iterate.com/stream/subscription-configured",
      }),
    ]),
  );
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
