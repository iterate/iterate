import { describe, expect, it, vi } from "vitest";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  capturePosthogStreamEventBatch,
  POSTHOG_STREAM_EVENT,
  POSTHOG_SUBSCRIPTION_KEY,
  posthogSubscriptionEvent,
} from "./posthog.ts";

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: "events.example.com/answer-recorded",
    path: "/agents/ada",
    offset: 7,
    createdAt: "2026-07-16T10:00:00.000Z",
    payload: { answer: 42, nested: { retained: true } },
    metadata: { source: "test", tags: ["complete"] },
    source: {
      processor: {
        slug: "agent",
        version: "1.2.3",
        stream: { projectId: "prj_123", path: "/agents/ada" },
        whileProcessing: { offset: 6, type: "events.example.com/question-asked" },
      },
      crossPostedFrom: [
        {
          subscriptionKey: "mirror",
          createdAt: "2026-07-16T09:59:00.000Z",
          offset: 3,
          path: "/source",
          projectId: "prj_123",
          type: "events.example.com/question-asked",
        },
      ],
    },
    idempotencyKey: "answer:42",
    ...overrides,
  };
}

function batch(events: StreamEvent[]): StreamPushEventBatch {
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
      offset: 4,
      createdAt: "2026-07-16T09:00:00.000Z",
      payload: posthogSubscriptionEvent().payload,
    },
  };
}

type CapturedRequest = {
  api_key: string;
  batch: Array<Record<string, unknown>>;
};

function acceptingFetch(requests: CapturedRequest[] = []) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return new Response(null, { status: 200 });
  });
}

function captureArgs(events: StreamEvent[], workerName = "os-preview-6") {
  return {
    apiKey: "phc_test",
    batch: batch(events),
    projectId: "prj_123",
    workerName,
  };
}

describe("first-party PostHog stream integration", () => {
  it("uses an ordinary all-history subscription that explicitly includes ephemeral rows", () => {
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

  it("captures the complete committed event and raw stream path", async () => {
    const durable = streamEvent();
    const ephemeral = streamEvent({
      type: "events.example.com/progress",
      offset: 8,
      ephemeral: true,
      payload: { token: "full payload retained" },
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
    expect(requests[0]).toMatchObject({ api_key: "phc_test" });
    expect(requests[0]!.batch).toHaveLength(2);
    expect(requests[0]!.batch[0]).toMatchObject({
      event: POSTHOG_STREAM_EVENT,
      properties: {
        $groups: { project: "prj_123" },
        distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
        project_id: "prj_123",
        stream_path: "/agents/ada",
        stream_event: durable,
        stream_event_type: durable.type,
        stream_event_uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    expect(requests[0]!.batch[0]).not.toHaveProperty("distinct_id");
    expect(requests[0]!.batch[1]).toMatchObject({
      event: POSTHOG_STREAM_EVENT,
      properties: {
        stream_event: ephemeral,
        stream_event_ephemeral: true,
      },
    });
  });

  it("models one project group by immutable id and its creation slug without filtering payload", async () => {
    const created = streamEvent({
      type: "events.iterate.com/project/created",
      path: "/",
      offset: 4,
      idempotencyKey: "project-created:prj_123",
      metadata: undefined,
      source: undefined,
      payload: {
        config: {
          creatorEmail: "owner@example.com",
          onboardingActive: true,
          slug: "gold-path",
        },
      },
    });
    const args = captureArgs([created]);
    args.batch.path = "/";
    const requests: CapturedRequest[] = [];

    await capturePosthogStreamEventBatch(args, { fetch: acceptingFetch(requests) });

    expect(requests[0]!.batch[0]).toMatchObject({
      event: "$groupidentify",
      properties: {
        $group_key: "prj_123",
        $group_set: { id: "prj_123", name: "gold-path", slug: "gold-path" },
        $group_type: "project",
        distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      },
    });
    expect(requests[0]!.batch[1]).toMatchObject({
      event: POSTHOG_STREAM_EVENT,
      properties: { stream_event: JSON.parse(JSON.stringify(created)) },
    });
    expect(JSON.stringify(requests[0])).toContain("owner@example.com");
  });

  it("creates the project group when any new stream first exports events", async () => {
    const created = streamEvent({
      type: "events.iterate.com/stream/created",
      offset: 1,
      idempotencyKey: undefined,
      metadata: undefined,
      source: undefined,
      payload: { projectId: "prj_123", path: "/agents/ada" },
    });
    const requests: CapturedRequest[] = [];

    await capturePosthogStreamEventBatch(captureArgs([created]), {
      fetch: acceptingFetch(requests),
    });

    expect(requests[0]!.batch).toHaveLength(2);
    expect(requests[0]!.batch[0]).toMatchObject({
      event: "$groupidentify",
      properties: {
        $group_key: "prj_123",
        $group_set: { id: "prj_123" },
        $group_type: "project",
      },
    });
    expect(requests[0]!.batch[1]).toMatchObject({
      event: POSTHOG_STREAM_EVENT,
      properties: { stream_event: JSON.parse(JSON.stringify(created)) },
    });
  });

  it("keeps source identity stable on retry and distinct between deployments", async () => {
    const first: CapturedRequest[] = [];
    const retry: CapturedRequest[] = [];
    const production: CapturedRequest[] = [];
    await capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
      fetch: acceptingFetch(first),
    });
    await capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
      fetch: acceptingFetch(retry),
    });
    await capturePosthogStreamEventBatch(captureArgs([streamEvent()], "os"), {
      fetch: acceptingFetch(production),
    });

    expect(first[0]!.batch[0]!.uuid).toBe(retry[0]!.batch[0]!.uuid);
    expect(first[0]!.batch[0]!.timestamp).toBe(retry[0]!.batch[0]!.timestamp);
    expect(first[0]!.batch[0]!.uuid).not.toBe(production[0]!.batch[0]!.uuid);
  });

  it("rejects malformed source timestamps and non-2xx capture responses", async () => {
    const invalidFetch = acceptingFetch();
    await expect(
      capturePosthogStreamEventBatch(captureArgs([streamEvent({ createdAt: "invalid" })]), {
        fetch: invalidFetch,
      }),
    ).rejects.toThrow("invalid createdAt timestamp");
    expect(invalidFetch).not.toHaveBeenCalled();

    await expect(
      capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
        fetch: vi.fn(async () => new Response("no", { status: 503 })),
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("does not call PostHog for an empty delivery batch", async () => {
    const captureFetch = acceptingFetch();
    await capturePosthogStreamEventBatch(captureArgs([]), { fetch: captureFetch });
    expect(captureFetch).not.toHaveBeenCalled();
  });
});
