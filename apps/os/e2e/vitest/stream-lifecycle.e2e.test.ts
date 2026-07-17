import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../src/domains/streams/schemas.ts";
import type { Stream } from "../../src/itx-api.generated.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

type RuntimeConnection = {
  subscriptionType?: "configured" | "ephemeral";
  startedAt?: string;
  hasPendingDelivery?: boolean;
  subscriber?: {
    description?: string;
  };
};

type ReducedConnection = {
  subscriptionType?: "configured" | "ephemeral";
  subscriber?: {
    description?: string;
  };
};

/** The per-subscription spine row `runtimeState().runtime.subscriptions` exposes. */
type RuntimeSubscription = {
  mode?: "wake" | "push" | "webhook";
  ackedOffset?: number;
  lag?: number;
  connected?: boolean;
};

/** The stored latest-config record `configuredSubscribersByKey` keeps per key. */
type ConfiguredSubscriberRecord = {
  latestConfiguredEvent?: {
    offset?: number;
    payload?: {
      subscriptionKey?: string;
      delivery?: { mode?: string; expression?: unknown[] };
      selector?: { eventTypes?: string[] };
    };
  };
};

type StreamRuntimeState = {
  coreProcessorState: {
    connectionsByKey?: Record<string, ReducedConnection>;
    configuredSubscribersByKey?: Record<string, ConfiguredSubscriberRecord>;
  };
  runtime: {
    connections: Record<string, RuntimeConnection>;
    subscriptions: Record<string, RuntimeSubscription>;
  };
};

const WAIT_FOR_EVENT_TYPE = "events.iterate.test/lifecycle-wait-never";

// These tests are intentionally about subscription lifecycle policy, not about
// the old inbound/outbound transport direction. The current model has two
// subscription types:
// - configured: durable desired state in `configuredSubscribersByKey`, one
//   `subscription-configured` event per key with a delivery mode. `wake` pokes
//   a Durable-Object-hosted processor and streams into the returned sink (a
//   live connection the stream may drop while idle, because the stored config
//   can re-wake the target); `push` dials a persisted itx expression fresh per
//   batch (no live connection; the stream owns the cursor).
// - ephemeral: a direct caller supplied a live callback via `subscribe()`; the
//   stream must keep it until unsubscribe, RPC break, or session end because
//   there is no durable wakeup path.
//
// Several of these started life as failing regression tests for streams keeping
// Durable Objects alive through retained callback stubs. The now-active tests
// prove the configured wake path is teardownable and re-wakeable, while direct
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
  }).rejects.toThrow(/reserved for a durable subscriber/);
});

test("delivery expressions must end in a property step, rejected before commit", async () => {
  // Cross-project safety needs no append-time check anymore: a delivery
  // expression carries no projectId at all — every delivery re-derives
  // authority from the stream's OWN itx root, so persisted config cannot name
  // another project structurally. What still needs pre-commit validation is
  // the expression's SHAPE: the dial invokes the final step as a method, so a
  // call-step tail is a config that can never deliver. If append accepted it
  // and delivery merely failed later, the stream would retain a bad durable
  // desired-state record and retry it forever. The final
  // `expectNoSubscriptionConfiguredEvent(...)` assertion proves rejection
  // happened before the event was committed.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-call-tail-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `configured-call-tail-${marker}` });
  using stream = project.streams.get(`/configured-call-tail-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        // Tail is a CALL step — the poke method name is missing.
        delivery: {
          mode: "wake",
          expression: ["repos", ["get", "/"]],
        },
      }),
    ),
  ).rejects.toThrow(/property step/);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("webhook subscriptions validate their URL before commit", async () => {
  // Same pre-commit doctrine for the webhook lane: a URL the dial can never
  // POST to must be rejected at append, not discovered as an eternal retry.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-webhook-url-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `configured-webhook-url-${marker}` });
  using stream = project.streams.get(`/configured-webhook-url-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        delivery: { mode: "webhook", url: `ftp://example.com/${marker}` },
      }),
    ),
  ).rejects.toThrow(/url|invalid/i);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("global streams reject webhook subscriptions before commit", async () => {
  // Webhook POSTs ride the project egress lane (attribution + interception);
  // a global (projectId: null) stream has no project to attribute them to,
  // so the config must die at the append gate, not as an eternal retry.
  const marker = crypto.randomUUID();
  const subscriptionKey = `configured-global-webhook-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using stream = itx.streams.get(`/configured-global-webhook-${marker}`);

  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        delivery: { mode: "webhook", url: `https://example.com/${marker}` },
      }),
    ),
  ).rejects.toThrow(/project-scoped/);

  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("subscription and subscribe inputs are validated at the door", async () => {
  // Three cheap gates, one project: a NaN replay cursor (NaN binds as SQL
  // NULL downstream — a live-looking subscription that delivers nothing), and
  // cursor-policy knobs on a wake config (silently-ignored config must not
  // commit).
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `lifecycle-input-gates-${marker}` });
  using stream = project.streams.get(`/lifecycle-input-gates-${marker}`);

  await expect(
    stream.subscribe({
      processEventBatch: () => undefined,
      replayAfterOffset: Number.NaN,
    }),
  ).rejects.toThrow(/non-negative integer/);

  const subscriptionKey = `wake-with-deliver-${marker}`;
  await expect(
    stream.append(
      subscriptionConfiguredEvent({
        subscriptionKey,
        delivery: {
          mode: "wake",
          expression: ["agents", ["get", "/agents/x"], "processor", "wakeStreamSubscriber"],
        },
        deliver: "all",
      }),
    ),
  ).rejects.toThrow(/only applies to push\/webhook/);
  await expectNoSubscriptionConfiguredEvent(stream, subscriptionKey);
});

test("wake expressions traverse dynamic dispatch surfaces (the slack router shape)", async () => {
  // Every other wake expression walks real getters (agents.get(p).processor,
  // repos.get(p).processor, ...). The slack router's walks the integrations
  // collection's DYNAMIC dotted proxy — ["integrations", "slack", ["get", <conn>],
  // "processor", "wakeStreamSubscriber"] — over the loopback RPC: awaited
  // property steps over proxy/function stubs, a different transport mechanic
  // entirely, and it replaced the old typed-target dial with no other running
  // coverage (thermo round 3, blocker 2). This pins the whole walk live: the
  // poke resolves the handshake through the proxy and a durable connection
  // lands on the stream.
  const marker = crypto.randomUUID();
  const connection = `e2e-${marker.slice(0, 8)}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `lifecycle-dynamic-wake-${marker}` });
  using stream = project.streams.get(`/integrations/slack/${connection}`);

  const subscriptionKey = `dynamic-wake-${marker}`;
  await stream.append(
    subscriptionConfiguredEvent({
      subscriptionKey,
      delivery: {
        mode: "wake",
        expression: [
          "integrations",
          "slack",
          ["get", connection],
          "processor",
          "wakeStreamSubscriber",
        ],
        processorSlug: "slack",
      },
    }),
  );

  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return state.runtime.subscriptions[subscriptionKey]?.connected === true;
    },
    {
      description: "the dynamic-proxy wake handshake to open a durable connection",
      timeoutMs: 30_000,
    },
  );

  // The presence fact is the durable proof the handshake completed.
  const events = await stream.getEvents({ afterOffset: 0 });
  expect(
    events.some(
      (event) =>
        event.type === "events.iterate.com/stream/subscriber-connected" &&
        (event.payload as { subscriptionKey?: string }).subscriptionKey === subscriptionKey,
    ),
  ).toBe(true);
});

test("project streams are born with a project-worker push feed callers cannot replace", async () => {
  // Stateless workers are no longer a wake-target kind: a worker consumes via
  // a PUSH subscription whose expression addresses it. Every project-scoped
  // stream self-configures the default feed at birth — subscriptionKey
  // "project-worker", expression ["processEventBatch"] (the project root's
  // dispatch point, delegating to the worker), deliver
  // "all", onPoison "skip" — in the same synchronous turn as `created`, so
  // there is no wiring window. The key is reserved because replacing this
  // birth feed could prevent the platform from installing required stream
  // integrations.
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `lifecycle-worker-feed-${marker}` });
  using stream = project.streams.get(`/lifecycle-worker-feed-${marker}`);

  // Born configured: a fresh child stream's runtime subscription table shows
  // the push feed before any caller wires anything.
  const initial = asStreamRuntimeState(await stream.runtimeState());
  expect(initial.runtime.subscriptions["project-worker"]?.mode).toBe("push");

  // Appending advances the feed's authoritative cursor once the project
  // worker acks the batch (durable delivery, so it retries until the seeded
  // worker answers).
  const [appended] = await stream.append({
    type: "events.iterate.test/lifecycle-worker-feed",
    payload: { marker },
  });
  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return (state.runtime.subscriptions["project-worker"]?.ackedOffset ?? 0) >= appended.offset;
    },
    {
      description: "project-worker feed ackedOffset to advance past the appended event",
      timeoutMs: 30_000,
    },
  );

  // A same-key replacement is rejected; there is no compatibility lane that
  // lets callers bypass the project-root dispatch point.
  const narrowedTypes = [`events.iterate.test/lifecycle-worker-feed-selected-${marker}`];
  await expect(
    stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "project-worker",
        delivery: { mode: "push", expression: ["worker", "processEventBatch"] },
        selector: { eventTypes: narrowedTypes },
        onPoison: "skip",
      },
    }),
  ).rejects.toThrow("the project worker birth subscription is managed by Iterate");

  const replaced = asStreamRuntimeState(await stream.runtimeState());
  const record = replaced.coreProcessorState.configuredSubscribersByKey?.["project-worker"];
  expect(record?.latestConfiguredEvent?.offset).toBe(2);
  expect(record?.latestConfiguredEvent?.payload?.delivery).toEqual({
    mode: "push",
    expression: ["processEventBatch"],
  });
  expect(record?.latestConfiguredEvent?.payload?.selector).toBeUndefined();
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

  const { keys } = await waitForConfiguredProcessorConnections(stream, { settled: true });

  await forceStreamIdleTeardown(stream);

  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return keys.every((key) => state.runtime.connections[key] === undefined);
    },
    {
      description: `configured processor connections to be severed by idle teardown (${keys.join(", ")})`,
      // Severance is asynchronous fan-out across three cross-script RPC
      // connections; 1.5s flaked under the CI-parallel lane profile (4 files x
      // concurrency 3 on one slot). The assertion is about eventual severance,
      // not a latency SLA.
      timeoutMs: 10_000,
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

  const { keys } = await waitForConfiguredProcessorConnections(stream, { settled: true });

  await forceStreamIdleTeardown(stream);

  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      return keys.every((key) => state.runtime.connections[key] === undefined);
    },
    {
      description: `configured processor connections to be absent before re-wake (${keys.join(", ")})`,
      // Same asynchronous fan-out as above — 1.5s flaked under CI-parallel load.
      timeoutMs: 10_000,
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
  const { projectId } = await project.__describe();
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(delivered).toEqual([]);
  } finally {
    disposeRpc(subscriberSession);
  }
});

// KNOWN GAP (2026-07-02, fails against deployed previews): when a WebSocket
// client drops mid-waitForEvent, the stream keeps the internal waitForEvent
// subscription until session cleanup notices — the DO stays pinned longer than
// it should (same failure family as the cross-script subscription DO-duration
// incident). Un-skip once waitForEvent registers an abort on transport drop.
test.skip("dropping a WebSocket waitForEvent caller cleans up the internal waitForEvent subscription", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/lifecycle-wait-for-event-${marker}`;

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = observerItx.projects.create({ slug: `lifecycle-wait-${marker}` });
  const { projectId } = await project.__describe();
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
        return state.runtime.connections[waitForEventKey] === undefined;
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

test("a stream DO kill mid-call rejects with the stream-unavailable tag", async () => {
  // The retryability contract: a rejection caused by the DO incarnation dying
  // (kill/eviction/deploy reset) must cross the wire tagged
  // `stream-unavailable: …` so clients can retry instead of treating it as an
  // app-level failure — the browser mirror's appendBatch rides exactly this
  // tag to survive kills mid-blast (see domains/streams/stream-unavailable.ts;
  // workerd's `durableObjectReset` flag never survives capnweb, so the worker
  // door is the only hop that can tell the two apart). The parked waitForEvent
  // makes the proof deterministic: its runtime connection registering proves
  // the call is in flight inside the DO when kill() lands.
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `lifecycle-kill-tag-${marker}` });
  using stream = project.streams.get(`/lifecycle-kill-tag-${marker}`);

  const parked = (async () => {
    try {
      await stream.waitForEvent({ eventTypes: [WAIT_FOR_EVENT_TYPE], timeoutMs: 60_000 });
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  await waitForWaitForEventConnection(stream);

  // The abort can take the kill() call itself down with it — that rejection
  // is incidental; the parked call's is the one under test.
  await stream.kill().catch(() => undefined);

  const rejection = await parked;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain("stream-unavailable: ");
  expect((rejection as Error).message).toContain("kill requested");
});

async function waitForConfiguredProcessorConnections(
  stream: Stream,
  opts: { expectedKeys?: readonly string[]; settled?: boolean } = {},
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
            latest!.coreProcessorState.connectionsByKey?.[key] !== undefined &&
            // `settled` waits for the last delivery into each sink to settle,
            // not just for the connection to exist: a sink whose replay batch
            // is still unsettled reads as wedged to a FORCED idle teardown,
            // which then re-pokes it (the at-least-once path) and the
            // connection reappears instantly — severance assertions would
            // race that re-poke. In production the idle window itself
            // guarantees settlement; forced teardown must wait explicitly.
            // Bootstrap ingestion can hold a delivery open for a while, so
            // only the teardown tests opt in (with a matching timeout).
            (opts.settled !== true ||
              latest!.runtime.connections[key]?.hasPendingDelivery === false),
        )
      );
    },
    {
      description:
        opts.settled === true
          ? "configured processor connections to become live and settled"
          : "configured processor connections to become live",
      timeoutMs: opts.settled === true ? 30_000 : undefined,
    },
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
  // Ephemeral connections live only in the runtime connection table — they
  // don't fold into the reduced `connectionsByKey` roster (core state v14).
  let key: string | undefined;
  await waitForCondition(
    async () => {
      const state = asStreamRuntimeState(await stream.runtimeState());
      key = Object.entries(state.runtime.connections).find(
        ([, connection]) => connection.subscriber?.description === "waitForEvent",
      )?.[0];
      return key !== undefined;
    },
    {
      description: "waitForEvent internal subscription to become visible",
      // Registration rides a fresh project's first stream calls: on a cold
      // preview DO under full lane contention that takes longer than the 5s
      // default (each runtimeState poll is its own RPC round-trip) — the
      // kill-tag test hit exactly this wall on preview CI.
      timeoutMs: 30_000,
    },
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
  // Only WAKE subscriptions hold live delivery connections (a poke returns a
  // sink the stream retains). Push subscriptions — the birth-certificate
  // project-worker feed among them — dial fresh per batch and never appear in
  // `runtime.connections`, so the connection-lifecycle tests must not wait on
  // them.
  return Object.entries(state.runtime.subscriptions)
    .filter(([, subscription]) => subscription.mode === "wake")
    .map(([key]) => key);
}

function asStreamRuntimeState(value: unknown): StreamRuntimeState {
  return value as StreamRuntimeState;
}

function subscriptionConfiguredEvent(input: {
  delivery: Record<string, unknown>;
  deliver?: string;
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
      delivery: input.delivery,
      ...(input.deliver === undefined ? {} : { deliver: input.deliver }),
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
