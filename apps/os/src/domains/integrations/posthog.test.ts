import { describe, expect, it, vi } from "vitest";
import {
  CoreProcessorContract,
  PROJECT_WORKER_SUBSCRIPTION_KEY,
} from "../streams/core-processor-contract.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  assertCanonicalPosthogDelivery,
  assertPosthogSubscriptionWriteAllowed,
  batchContainsCanonicalStreamCreated,
  capturePosthogStreamEventBatch,
  POSTHOG_STREAM_EVENT,
  POSTHOG_SUBSCRIPTION_KEY,
  posthogSubscriptionEvent,
} from "./posthog.ts";

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: "customer-defined/event",
    path: "/agents/ada",
    offset: 7,
    createdAt: "2026-07-16T10:00:00.000Z",
    payload: { answer: 42 },
    metadata: { source: "test" },
    idempotencyKey: "customer-key",
    ...overrides,
  };
}

function batch(events: StreamEvent[]): StreamPushEventBatch {
  const canonical = CoreProcessorContract.parseEventInput(
    "events.iterate.com/stream/subscription-configured",
    posthogSubscriptionEvent(),
  );
  return {
    projectId: "prj_123",
    path: "/agents/ada",
    events,
    streamMaxOffset: 99,
    subscriptionKey: POSTHOG_SUBSCRIPTION_KEY,
    deliveryId: `${POSTHOG_SUBSCRIPTION_KEY}:7-8`,
    attempt: 2,
    configuredEvent: {
      type: "events.iterate.com/stream/subscription-configured",
      path: "/agents/ada",
      offset: 3,
      createdAt: "2026-07-16T09:00:00.000Z",
      // The fold stores the schema-parsed payload, whose property order is
      // different from the builder. This is the real delivery shape.
      payload: canonical.payload,
    },
  };
}

function projectWorkerBatch(events: StreamEvent[]): StreamPushEventBatch {
  return {
    ...batch(events),
    subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
    configuredEvent: {
      type: "events.iterate.com/stream/subscription-configured",
      path: "/agents/ada",
      offset: 2,
      createdAt: "2026-07-16T09:00:00.000Z",
      payload: {
        subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
        delivery: { mode: "push", expression: ["processEventBatch"] },
        deliver: "all",
        onPoison: "skip",
      },
    },
  };
}

type CapturedRequest = {
  api_key: string;
  batch: Array<Record<string, unknown>>;
};

function acceptingFetch(requests: CapturedRequest[] = []) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    requests.push(body);
    return new Response(null, { status: 200 });
  });
}

const captureArgs = (events: StreamEvent[], workerName = "os-preview-6") => ({
  apiKey: "phc_test",
  batch: batch(events),
  projectId: "prj_123",
  workerName,
});

const projectStream = { authority: "userspace", projectId: "prj_123" } as const;

function assertPosthogRecoveryEventAllowed(event: StreamEvent, projectId: string | null): void {
  assertPosthogSubscriptionWriteAllowed([event], { authority: "recovery", projectId });
}

describe("first-party PostHog stream integration", () => {
  it("defines one protected all-history, all-row subscription with bounded failure", () => {
    const event = posthogSubscriptionEvent();
    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: "iterate-platform-posthog-subscription-v1",
      payload: {
        subscriptionKey: POSTHOG_SUBSCRIPTION_KEY,
        description: "Iterate's first-party, all-event PostHog feed",
        delivery: {
          mode: "push",
          expression: ["integrations", "posthog", "processEventBatch"],
        },
        deliver: "all",
        includeEphemeral: true,
        onPoison: "park",
      },
    });
    expect(() =>
      CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        event,
      ),
    ).not.toThrow();
  });

  it("accepts only the canonical delivery route and configuration", () => {
    expect(() => assertCanonicalPosthogDelivery(batch([streamEvent()]))).not.toThrow();
    expect(() =>
      assertCanonicalPosthogDelivery({
        ...batch([streamEvent()]),
        subscriptionKey: "customer-feed",
      }),
    ).toThrow(/canonical stream subscription/);
    expect(() =>
      assertCanonicalPosthogDelivery({
        ...batch([streamEvent()]),
        configuredEvent: { ...batch([streamEvent()]).configuredEvent, path: "/other" },
      }),
    ).toThrow(/canonical stream subscription/);
    expect(() =>
      assertCanonicalPosthogDelivery({
        ...batch([streamEvent()]),
        configuredEvent: {
          ...batch([streamEvent()]).configuredEvent,
          payload: { ...posthogSubscriptionEvent().payload, onPoison: "skip" },
        },
      }),
    ).toThrow(/canonical stream subscription/);
  });

  it("reserves the key, idempotency key, and ephemeral durable-delivery power", () => {
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([posthogSubscriptionEvent()], projectStream),
    ).toThrow(/managed by Iterate/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [
          {
            type: "events.iterate.com/stream/subscription-removed",
            payload: { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY },
          },
        ],
        projectStream,
      ),
    ).toThrow(/managed by Iterate/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: "another-feed",
              delivery: { mode: "push", expression: ["processEventBatch"] },
              includeEphemeral: true,
            },
          },
        ],
        projectStream,
      ),
    ).toThrow(/managed by Iterate/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: "guaranteed-error-spam",
              delivery: {
                mode: "push",
                expression: ["integrations", "posthog", "processEventBatch"],
              },
            },
          },
        ],
        projectStream,
      ),
    ).toThrow(/delivery route is managed by Iterate/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([posthogSubscriptionEvent()], {
        authority: "managed",
        projectId: "prj_123",
      }),
    ).not.toThrow();
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([posthogSubscriptionEvent()], {
        authority: "admin",
        projectId: "prj_123",
      }),
    ).toThrow(/managed by Iterate/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [{ ...posthogSubscriptionEvent(), metadata: { forged: true } }],
        { authority: "managed", projectId: "prj_123" },
      ),
    ).toThrow(/noncanonical owner/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([posthogSubscriptionEvent()], {
        authority: "managed",
        projectId: null,
      }),
    ).toThrow(/requires a project stream/);

    const projectWorkerBirth = projectWorkerBatch([streamEvent()]).configuredEvent;
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([projectWorkerBirth], projectStream),
    ).toThrow(/project worker birth subscription is managed/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([projectWorkerBirth], {
        authority: "recovery",
        projectId: "prj_123",
      }),
    ).not.toThrow();
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([projectWorkerBirth], {
        authority: "recovery",
        projectId: null,
      }),
    ).toThrow(/requires a project stream/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [
          {
            type: "events.iterate.com/stream/subscription-cursor-set",
            payload: { subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY, afterOffset: 1 },
          },
        ],
        { authority: "admin", projectId: "prj_123" },
      ),
    ).toThrow(/project worker birth subscription is managed/);
    expect(() =>
      assertPosthogSubscriptionWriteAllowed(
        [
          {
            type: "events.iterate.com/stream/subscription-resumed",
            payload: { subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY },
          },
        ],
        { authority: "admin", projectId: "prj_123" },
      ),
    ).not.toThrow();
  });

  it("provisions only from the stream's canonical offset-one birth certificate", () => {
    const created = streamEvent({
      type: "events.iterate.com/stream/created",
      offset: 1,
      payload: { projectId: "prj_123", path: "/agents/ada" },
      metadata: undefined,
      idempotencyKey: undefined,
    });
    expect(batchContainsCanonicalStreamCreated(projectWorkerBatch([created]))).toBe(true);
    expect(
      batchContainsCanonicalStreamCreated(projectWorkerBatch([{ ...created, offset: 2 }])),
    ).toBe(false);
    expect(
      batchContainsCanonicalStreamCreated(
        projectWorkerBatch([
          {
            ...created,
            source: {
              crossPostedFrom: [
                {
                  subscriptionKey: "forged",
                  createdAt: created.createdAt,
                  offset: 1,
                  path: "/other",
                  projectId: "prj_123",
                  type: created.type,
                },
              ],
            },
          },
        ]),
      ),
    ).toBe(false);
    expect(
      batchContainsCanonicalStreamCreated({
        ...projectWorkerBatch([created]),
        subscriptionKey: "attacker",
      }),
    ).toBe(false);
    expect(
      batchContainsCanonicalStreamCreated({
        ...projectWorkerBatch([created]),
        configuredEvent: {
          ...projectWorkerBatch([created]).configuredEvent,
          path: "/other",
        },
      }),
    ).toBe(false);
    expect(
      batchContainsCanonicalStreamCreated({
        ...projectWorkerBatch([created]),
        configuredEvent: {
          ...projectWorkerBatch([created]).configuredEvent,
          payload: {
            subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
            delivery: { mode: "push", expression: ["processEventBatch"] },
            deliver: "new",
            onPoison: "skip",
          },
        },
      }),
    ).toBe(false);
  });

  it("accepts only authentic first-hand PostHog control history during recovery", () => {
    const canonical = {
      ...posthogSubscriptionEvent(),
      path: "/agents/ada",
      offset: 2,
      createdAt: "2026-07-16T09:00:00.000Z",
    } satisfies StreamEvent;
    expect(() => assertPosthogRecoveryEventAllowed(canonical, "prj_123")).not.toThrow();
    expect(() =>
      assertPosthogRecoveryEventAllowed({ ...canonical, ephemeral: true }, "prj_123"),
    ).toThrow(/noncanonical owner/);
    expect(() =>
      assertPosthogRecoveryEventAllowed(
        {
          ...canonical,
          type: "customer/event",
          payload: {},
        },
        "prj_123",
      ),
    ).toThrow(/noncanonical owner/);

    const removed = streamEvent({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY },
    });
    expect(() => assertPosthogRecoveryEventAllowed(removed, "prj_123")).toThrow(
      /managed by Iterate/,
    );
    expect(() =>
      assertPosthogRecoveryEventAllowed(
        streamEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: "attacker",
            delivery: {
              mode: "push",
              expression: ["integrations", "posthog", "processEventBatch"],
            },
          },
        }),
        "prj_123",
      ),
    ).toThrow(/delivery route is managed by Iterate/);

    const lifecycle = [
      streamEvent({
        type: "events.iterate.com/stream/subscription-parked",
        idempotencyKey: undefined,
        metadata: undefined,
        payload: { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY, atOffset: 4, attempts: 15 },
      }),
      streamEvent({
        type: "events.iterate.com/stream/subscription-resumed",
        idempotencyKey: undefined,
        metadata: undefined,
        payload: { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY },
      }),
      streamEvent({
        type: "events.iterate.com/stream/subscription-cursor-set",
        idempotencyKey: undefined,
        metadata: undefined,
        payload: { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY, afterOffset: 0 },
      }),
    ];
    for (const event of lifecycle) {
      expect(() => assertPosthogRecoveryEventAllowed(event, "prj_123")).not.toThrow();
      expect(() =>
        assertPosthogRecoveryEventAllowed(
          {
            ...event,
            source: {
              crossPostedFrom: [
                {
                  subscriptionKey: "forged",
                  createdAt: event.createdAt,
                  offset: 1,
                  path: "/other",
                  projectId: "prj_123",
                  type: event.type,
                },
              ],
            },
          },
          "prj_123",
        ),
      ).toThrow(/managed by Iterate/);
    }
    for (const event of lifecycle.slice(1)) {
      expect(() =>
        assertPosthogSubscriptionWriteAllowed([event], {
          authority: "admin",
          projectId: "prj_123",
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertPosthogSubscriptionWriteAllowed([lifecycle[0]!], {
        authority: "admin",
        projectId: "prj_123",
      }),
    ).toThrow(/managed by Iterate/);
    expect(() => assertPosthogRecoveryEventAllowed(canonical, null)).toThrow(
      /requires a project stream/,
    );
  });

  it("captures every row with one immutable first-class project group", async () => {
    const durable = streamEvent();
    const ephemeral = streamEvent({
      type: "events.iterate.com/customer/ephemeral",
      offset: 8,
      ephemeral: true,
      payload: { arbitrary: "customer value" },
    });
    const requests: CapturedRequest[] = [];
    const captureFetch = acceptingFetch(requests);

    await capturePosthogStreamEventBatch(captureArgs([durable, ephemeral]), {
      fetch: captureFetch,
    });

    expect(captureFetch).toHaveBeenCalledOnce();
    const [url, init] = captureFetch.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/batch/");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    const request = requests[0]!;
    expect(request.api_key).toBe("phc_test");
    expect(request).not.toHaveProperty("sent_at");
    expect(request.batch).toHaveLength(2);
    expect(request.batch[0]).toMatchObject({
      distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      event: POSTHOG_STREAM_EVENT,
    });
    expect(request.batch.map((event) => event.event)).toEqual([
      POSTHOG_STREAM_EVENT,
      POSTHOG_STREAM_EVENT,
    ]);
    expect(request.batch[1]).toMatchObject({
      distinct_id: request.batch[0]!.distinct_id,
      properties: {
        $geoip_disable: true,
        $groups: { project: "prj_123" },
        $is_server: true,
        project_id: "prj_123",
        stream_event_created_at: "2026-07-16T10:00:00.000Z",
        stream_event_ephemeral: true,
        stream_event_offset: 8,
        stream_event_type: "events.iterate.com/customer/ephemeral",
        stream_event_type_truncated: false,
        stream_event_uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
        stream_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        worker_name: "os-preview-6",
      },
    });
    expect(request.batch[1]!.properties).not.toHaveProperty("stream_event");
  });

  it("identifies the immutable project id and slug from the authentic project birth", async () => {
    const created = streamEvent({
      type: "events.iterate.com/project/created",
      path: "/",
      offset: 3,
      idempotencyKey: "project-created:prj_123",
      metadata: undefined,
      source: undefined,
      payload: {
        config: {
          creatorEmail: "private@example.com",
          onboardingActive: true,
          slug: "gold-path",
        },
      },
    });
    const firstArgs = captureArgs([created]);
    firstArgs.batch.path = "/";
    const first: CapturedRequest[] = [];
    const retry: CapturedRequest[] = [];

    await capturePosthogStreamEventBatch(firstArgs, { fetch: acceptingFetch(first) });
    await capturePosthogStreamEventBatch(firstArgs, { fetch: acceptingFetch(retry) });

    expect(first[0]!.batch).toHaveLength(2);
    expect(first[0]!.batch[0]).toEqual({
      distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      event: "$groupidentify",
      properties: {
        $geoip_disable: true,
        $group_key: "prj_123",
        $group_set: { id: "prj_123", name: "gold-path", slug: "gold-path" },
        $group_type: "project",
        $is_server: true,
      },
      timestamp: created.createdAt,
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(first[0]!.batch[1]).toMatchObject({
      event: POSTHOG_STREAM_EVENT,
      properties: { $groups: { project: "prj_123" }, stream_event_offset: 3 },
    });
    expect(JSON.stringify(first[0])).not.toContain("private@example.com");
    expect(first[0]!.batch[0]).toEqual(retry[0]!.batch[0]);
  });

  it("does not infer group properties from lookalike project events", async () => {
    const authentic = streamEvent({
      type: "events.iterate.com/project/created",
      path: "/",
      offset: 3,
      idempotencyKey: "project-created:prj_123",
      metadata: undefined,
      source: undefined,
      payload: { config: { slug: "gold-path" } },
    });
    const lookalikes: StreamEvent[] = [
      { ...authentic, path: "/other" },
      { ...authentic, idempotencyKey: "forged" },
      { ...authentic, metadata: { forged: true } },
      {
        ...authentic,
        source: {
          crossPostedFrom: [
            {
              subscriptionKey: "forged",
              createdAt: authentic.createdAt,
              offset: 1,
              path: "/other",
              projectId: "prj_123",
              type: authentic.type,
            },
          ],
        },
      },
      { ...authentic, ephemeral: true },
    ];

    for (const event of lookalikes) {
      const args = captureArgs([event]);
      args.batch.path = "/";
      const requests: CapturedRequest[] = [];
      await capturePosthogStreamEventBatch(args, { fetch: acceptingFetch(requests) });
      expect(requests[0]!.batch.map((item) => item.event)).toEqual([POSTHOG_STREAM_EVENT]);
    }
  });

  it("isolates the operational identity and limiter key by deployment and project", async () => {
    const requests: CapturedRequest[] = [];
    const captureFetch = acceptingFetch(requests);

    await capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
      fetch: captureFetch,
    });
    const otherProject = captureArgs([streamEvent()]);
    otherProject.projectId = "prj_456";
    otherProject.batch.projectId = "prj_456";
    await capturePosthogStreamEventBatch(otherProject, { fetch: captureFetch });

    const firstIdentity = requests[0]!.batch[0]!.distinct_id;
    const secondIdentity = requests[1]!.batch[0]!.distinct_id;
    expect(firstIdentity).not.toBe(secondIdentity);
    expect(requests[0]!.batch[0]!.distinct_id).toBe(firstIdentity);
    expect(requests[1]!.batch[0]!.distinct_id).toBe(secondIdentity);
  });

  it("indexes every custom event type as a bounded operational identifier", async () => {
    const requests: CapturedRequest[] = [];
    const eventType = `custom/${"x".repeat(4_000)}`;
    await capturePosthogStreamEventBatch(captureArgs([streamEvent({ type: eventType })]), {
      fetch: acceptingFetch(requests),
    });
    const properties = requests[0]!.batch[0]!.properties as Record<string, unknown>;
    expect(properties.stream_event_type).toBe(eventType.slice(0, 1_024));
    expect(properties.stream_event_type_truncated).toBe(true);
    expect(properties.stream_event_uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps stream identity bounded without exporting a user-controlled path", async () => {
    const input = captureArgs([streamEvent({ path: `/${"x".repeat(2_000)}` })]);
    input.batch.path = `/${"x".repeat(2_000)}`;
    const requests: CapturedRequest[] = [];
    await capturePosthogStreamEventBatch(input, { fetch: acceptingFetch(requests) });
    expect(String(requests[0]!.batch[0]!.distinct_id).length).toBeLessThanOrEqual(200);
    expect(requests[0]!.batch[0]!.properties).toMatchObject({
      stream_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(requests[0]!.batch[0]!.properties).not.toHaveProperty("stream_path");
  });

  it("rejects an invalid recovered timestamp before capture", async () => {
    const invalid = captureArgs([streamEvent({ createdAt: "not-a-timestamp" })]);
    const invalidFetch = acceptingFetch();
    await expect(capturePosthogStreamEventBatch(invalid, { fetch: invalidFetch })).rejects.toThrow(
      "invalid createdAt timestamp",
    );
    expect(invalidFetch).not.toHaveBeenCalled();
  });

  it("indexes a multi-megabyte row without copying its payload into PostHog", async () => {
    const huge = streamEvent({ payload: { body: "x".repeat(3 * 1_024 * 1_024) } });
    let captureBody = "";
    const captureFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captureBody = String(init?.body);
      return new Response(null, { status: 200 });
    });

    await capturePosthogStreamEventBatch(captureArgs([huge]), { fetch: captureFetch });

    expect(captureBody.length).toBeLessThan(10_000);
    expect(captureBody).not.toContain(huge.payload!.body as string);
  });

  it("does not copy a complete unbounded event type into UUID material or the request", async () => {
    const hugeType = `custom/${"x".repeat(3 * 1_024 * 1_024)}`;
    let captureBody = "";
    const captureFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captureBody = String(init?.body);
      return new Response(null, { status: 200 });
    });

    await capturePosthogStreamEventBatch(captureArgs([streamEvent({ type: hugeType })]), {
      fetch: captureFetch,
    });

    expect(captureBody.length).toBeLessThan(10_000);
    expect(captureBody).not.toContain(hugeType);
  });

  it("keeps retry UUIDs stable without conflating deployments or recreated streams", async () => {
    const event = streamEvent();
    const first: CapturedRequest[] = [];
    const retry: CapturedRequest[] = [];
    const production: CapturedRequest[] = [];
    const recreated: CapturedRequest[] = [];
    await capturePosthogStreamEventBatch(captureArgs([event]), { fetch: acceptingFetch(first) });
    await capturePosthogStreamEventBatch(captureArgs([event]), { fetch: acceptingFetch(retry) });
    await capturePosthogStreamEventBatch(captureArgs([event], "os"), {
      fetch: acceptingFetch(production),
    });
    await capturePosthogStreamEventBatch(
      captureArgs([streamEvent({ createdAt: "2026-07-17T10:00:00.000Z" })]),
      { fetch: acceptingFetch(recreated) },
    );

    expect(first[0]!.batch[0]!.uuid).toBe(retry[0]!.batch[0]!.uuid);
    expect(first[0]!.batch[0]!.uuid).not.toBe(production[0]!.batch[0]!.uuid);
    expect(first[0]!.batch[0]!.uuid).not.toBe(recreated[0]!.batch[0]!.uuid);
  });

  it("keeps the complete PostHog deduplication identity stable across retries", async () => {
    const first: CapturedRequest[] = [];
    const retry: CapturedRequest[] = [];
    const args = captureArgs([streamEvent()]);

    await capturePosthogStreamEventBatch(args, { fetch: acceptingFetch(first) });
    await capturePosthogStreamEventBatch(args, { fetch: acceptingFetch(retry) });

    expect(first[0]).not.toHaveProperty("sent_at");
    expect(retry[0]).not.toHaveProperty("sent_at");
    expect(first[0]!.batch.map(({ timestamp, uuid }) => ({ timestamp, uuid }))).toEqual(
      retry[0]!.batch.map(({ timestamp, uuid }) => ({ timestamp, uuid })),
    );
    expect(first[0]!.batch[0]!.timestamp).toBe("2026-07-16T10:00:00.000Z");
  });

  it("uses unambiguous coordinate identities for adversarial paths and event types", async () => {
    const first: CapturedRequest[] = [];
    const second: CapturedRequest[] = [];
    const firstArgs = captureArgs([streamEvent({ offset: 1, type: "2/foo" })]);
    firstArgs.batch.path = "/x";
    const secondArgs = captureArgs([streamEvent({ offset: 2, type: "foo" })]);
    secondArgs.batch.path = "/x/1";

    await capturePosthogStreamEventBatch(firstArgs, { fetch: acceptingFetch(first) });
    await capturePosthogStreamEventBatch(secondArgs, { fetch: acceptingFetch(second) });

    expect(first[0]!.batch[0]!.uuid).not.toBe(second[0]!.batch[0]!.uuid);
  });

  it("acknowledges public HTTP acceptance and rejects transport failure", async () => {
    const args = captureArgs([streamEvent()]);
    await expect(
      capturePosthogStreamEventBatch(args, {
        fetch: vi.fn(async () => new Response("accepted", { status: 200 })),
      }),
    ).resolves.toBeUndefined();
    await expect(
      capturePosthogStreamEventBatch(args, {
        fetch: vi.fn(async () => new Response("do not echo this body", { status: 429 })),
      }),
    ).rejects.toThrow("PostHog batch capture rejected the request with HTTP 429");
  });
});
