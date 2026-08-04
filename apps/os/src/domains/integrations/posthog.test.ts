import { describe, expect, it, vi } from "vitest";
import type { StreamDeliveryBatch } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import {
  capturePosthogStreamEventBatch,
  POSTHOG_STREAM_EVENT_MAX_JSON_BYTES,
  posthogSubscriptionEvent,
} from "./posthog.ts";

const POSTHOG_STREAM_APPEND_EVENT = "stream:append";
const POSTHOG_SUBSCRIPTION_NAME = "iterate-platform-posthog";
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

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
        stream: {
          projectId: "prj_123",
          path: "/agents/ada",
          streamId: "11111111-1111-4111-8111-111111111111",
        },
        whileProcessing: { offset: 6, type: "events.example.com/question-asked" },
      },
      copiedFrom: [
        {
          name: "mirror",
          streamId: "11111111-1111-4111-8111-111111111111",
          streamCreatedAt: "2026-07-16T09:00:00.000Z",
          cursorChangedAtSourceOffset: 1,
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

function batch(events: StreamEvent[]): StreamDeliveryBatch {
  return {
    projectId: "prj_123",
    path: "/agents/ada",
    streamId: "11111111-1111-4111-8111-111111111111",
    streamCreatedAt: "2026-07-16T09:00:00.000Z",
    events,
    streamMaxOffset: 99,
    name: POSTHOG_SUBSCRIPTION_NAME,
    cursorChangedAtSourceOffset: 4,
    deliveryId: `${POSTHOG_SUBSCRIPTION_NAME}:7-8`,
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

function captureArgs(events: StreamEvent[], workerName = "os-prd") {
  return {
    apiKey: "phc_test",
    batch: batch(events),
    projectId: "prj_123",
    workerName,
  };
}

describe("first-party PostHog stream integration", () => {
  it("uses an all-history subscription that excludes ephemeral events", () => {
    const event = posthogSubscriptionEvent();
    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: "iterate-platform-posthog-subscription-v4",
      payload: {
        name: POSTHOG_SUBSCRIPTION_NAME,
        description: "Iterate's first-party durable-event PostHog feed",
        receiver: {
          action: "itx-call",
          expression: ["integrations", "posthog", "processEventBatch"],
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
    });
    expect(() => CoreProcessorContract.parseEventInput(event)).not.toThrow();
  });

  it("captures the raw durable event with only useful indexed dimensions", async () => {
    const durable = streamEvent();
    const requests: CapturedRequest[] = [];
    const captureFetch = acceptingFetch(requests);

    await capturePosthogStreamEventBatch(captureArgs([durable]), {
      fetch: captureFetch,
    });

    expect(captureFetch).toHaveBeenCalledOnce();
    const [url, init] = captureFetch.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/batch/");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(requests[0]).toMatchObject({ api_key: "phc_test" });
    expect(requests[0]!.batch).toHaveLength(1);
    const occurrence = requests[0]!.batch[0]!;
    expect(occurrence).toMatchObject({
      event: POSTHOG_STREAM_APPEND_EVENT,
    });
    expect(occurrence.properties).toEqual({
      $geoip_disable: true,
      $groups: { project: "prj_123" },
      $is_server: true,
      distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      stream_event: durable,
      stream_event_original_json_bytes: jsonBytes(durable),
      stream_event_truncated: false,
      stream_event_type: durable.type,
      stream_path: "/agents/ada",
    });
  });

  it("drops ephemeral events from capture, including all-ephemeral batches", async () => {
    const durable = streamEvent();
    const ephemeral = streamEvent({
      type: "events.example.com/progress",
      offset: 8,
      ephemeral: true,
      payload: { token: "should never reach PostHog" },
    });
    const mixed: CapturedRequest[] = [];
    const mixedFetch = acceptingFetch(mixed);
    await capturePosthogStreamEventBatch(captureArgs([durable, ephemeral]), {
      fetch: mixedFetch,
    });
    expect(mixedFetch).toHaveBeenCalledOnce();
    expect(mixed[0]!.batch).toHaveLength(1);
    expect(mixed[0]!.batch[0]).toMatchObject({
      event: POSTHOG_STREAM_APPEND_EVENT,
      properties: {
        stream_event: durable,
      },
    });

    const onlyEphemeral: CapturedRequest[] = [];
    const onlyEphemeralFetch = acceptingFetch(onlyEphemeral);
    await capturePosthogStreamEventBatch(captureArgs([ephemeral]), {
      fetch: onlyEphemeralFetch,
    });
    expect(onlyEphemeralFetch).not.toHaveBeenCalled();
    expect(onlyEphemeral).toEqual([]);
  });

  it("bounds an oversized committed event while retaining its useful dimensions", async () => {
    const oversized = streamEvent({
      payload: {
        answer: 42,
        transcript: "x".repeat(POSTHOG_STREAM_EVENT_MAX_JSON_BYTES * 2),
      },
    });
    const requests: CapturedRequest[] = [];

    await capturePosthogStreamEventBatch(captureArgs([oversized]), {
      fetch: acceptingFetch(requests),
    });

    const occurrence = requests[0]!.batch[0]!;
    const properties = occurrence.properties as Record<string, unknown>;
    expect(occurrence.event).toBe(POSTHOG_STREAM_APPEND_EVENT);
    expect(properties).toMatchObject({
      stream_event_original_json_bytes: jsonBytes(oversized),
      stream_event_truncated: true,
      stream_event_type: oversized.type,
      stream_path: "/agents/ada",
    });
    expect(
      new TextEncoder().encode(JSON.stringify(properties.stream_event)).byteLength,
    ).toBeLessThanOrEqual(POSTHOG_STREAM_EVENT_MAX_JSON_BYTES);
    expect(properties.stream_event).toMatchObject({
      payload: { answer: 42 },
      type: oversized.type,
    });
  });

  it("identifies the project group from the authentic project birth", async () => {
    const created = streamEvent({
      type: "events.iterate.com/project/created",
      path: "/",
      offset: 4,
      idempotencyKey: internalStreamId("project-creation-terminal", "prj_123", "created"),
      metadata: undefined,
      source: undefined,
      payload: {
        createRequestedAtOffset: 1,
        config: {
          creatorEmail: "owner@example.com",
          slug: "gold-path",
        },
      },
    });
    const args = captureArgs([created]);
    args.batch.path = "/";
    const requests: CapturedRequest[] = [];

    await capturePosthogStreamEventBatch(args, { fetch: acceptingFetch(requests) });

    expect(requests[0]!.batch).toHaveLength(3);
    expect(requests[0]!.batch[0]).toMatchObject({
      event: "$groupidentify",
      properties: {
        $group_key: "prj_123",
        $group_set: {
          id: "prj_123",
          name: "gold-path",
          slug: "gold-path",
        },
        $group_type: "project",
        distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      },
    });
    expect(requests[0]!.batch[1]).toMatchObject({
      event: "$set",
      properties: {
        $groups: { project: "prj_123" },
        $set: { name: "project:gold-path" },
        distinct_id: expect.stringMatching(/^iterate-os-project:[0-9a-f-]{36}$/),
      },
    });
    const capturedBirth = requests[0]!.batch[2]!;
    expect(capturedBirth).toMatchObject({
      event: POSTHOG_STREAM_APPEND_EVENT,
      properties: {
        $groups: { project: "prj_123" },
      },
    });
    expect(JSON.stringify((capturedBirth.properties as Record<string, unknown>).stream_event)).toBe(
      JSON.stringify(created),
    );

    const ephemeralFetch = acceptingFetch();
    const ephemeralArgs = captureArgs([{ ...created, ephemeral: true }]);
    ephemeralArgs.batch.path = "/";
    await capturePosthogStreamEventBatch(ephemeralArgs, { fetch: ephemeralFetch });
    expect(ephemeralFetch).not.toHaveBeenCalled();
  });

  it("does not overwrite project group metadata from ordinary stream births", async () => {
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

    expect(requests[0]!.batch).toHaveLength(1);
    const capturedBirth = requests[0]!.batch[0]!;
    expect(capturedBirth).toMatchObject({
      event: POSTHOG_STREAM_APPEND_EVENT,
    });
    expect(JSON.stringify((capturedBirth.properties as Record<string, unknown>).stream_event)).toBe(
      JSON.stringify(created),
    );
  });

  it("keeps source identity stable on retry", async () => {
    const first: CapturedRequest[] = [];
    const retry: CapturedRequest[] = [];
    await capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
      fetch: acceptingFetch(first),
    });
    await capturePosthogStreamEventBatch(captureArgs([streamEvent()]), {
      fetch: acceptingFetch(retry),
    });

    expect(first[0]!.batch[0]!.uuid).toBe(retry[0]!.batch[0]!.uuid);
    expect(first[0]!.batch[0]!.timestamp).toBe(retry[0]!.batch[0]!.timestamp);
    const retryProperties = retry[0]!.batch[0]!.properties as Record<string, unknown>;
    expect(first[0]!.batch[0]!.properties).toMatchObject({
      $groups: { project: "prj_123" },
      distinct_id: retryProperties.distinct_id,
    });
  });

  it("uses a different source identity after stream recreation", async () => {
    const first: CapturedRequest[] = [];
    const recreated: CapturedRequest[] = [];
    const event = streamEvent();

    await capturePosthogStreamEventBatch(captureArgs([event]), {
      fetch: acceptingFetch(first),
    });
    await capturePosthogStreamEventBatch(
      {
        ...captureArgs([event]),
        batch: {
          ...batch([event]),
          streamId: "22222222-2222-4222-8222-222222222222",
        },
      },
      { fetch: acceptingFetch(recreated) },
    );

    expect(recreated[0]!.batch[0]!.uuid).not.toBe(first[0]!.batch[0]!.uuid);
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

  it("rejects an impossible empty delivery batch", async () => {
    const captureFetch = acceptingFetch();
    await expect(
      capturePosthogStreamEventBatch(captureArgs([]), { fetch: captureFetch }),
    ).rejects.toThrow("must contain an event");
    expect(captureFetch).not.toHaveBeenCalled();
  });
});
