import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { StreamDeliveryBatch } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { truncateJsonToBytes } from "../../lib/truncate-json.ts";

export const POSTHOG_STREAM_EVENT_MAX_JSON_BYTES = 100 * 1_024;

const StreamEventTimestamp = z.iso.datetime({ offset: true });
const ProjectGroupBirthPayload = z.object({
  config: z.object({
    slug: z.string(),
  }),
});

/** The durable subscription appended to every new project stream. */
export function posthogSubscriptionEvent() {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    // Bump when the subscription payload changes so new stream births land
    // the revised config. Existing streams still rely on capture-side filtering
    // until they are recreated or reconfigured.
    idempotencyKey: "iterate-platform-posthog-subscription-v4",
    payload: {
      name: "iterate-platform-posthog",
      description: "Iterate's first-party durable-event PostHog feed",
      receiver: {
        action: "itx-call",
        expression: ["integrations", "posthog", "processEventBatch"],
        delivery: {
          start: "beginning",
          onFailingEvent: "halt",
        },
      },
    } satisfies SubscriptionConfiguredPayload,
  };
}

function posthogUuid(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), uuidv5.URL);
}

function eventIdentity(
  workerName: string,
  projectId: string,
  path: string,
  streamId: string,
  event: Pick<StreamEvent, "offset"> & { createdAt: string },
): string {
  // Deployment identity, durable stream coordinate, and stream-lifetime ID
  // distinguish preview/prd and every committed row, while an exact at-least-once
  // redelivery keeps the same PostHog UUID. PostHog's ingestion-side UUID
  // deduplication is best-effort, so the source stream remains authoritative:
  // https://posthog.com/docs/api/capture
  // JSON-array encoding is unambiguous even when a user-controlled path
  // contains `/`. A recovered row at the same coordinate is the same source
  // occurrence.
  return posthogUuid([
    "stream-event-v2",
    workerName,
    projectId,
    path,
    streamId,
    event.offset,
    event.createdAt,
  ]);
}

function normalizeEventTimestamp(createdAt: string): string {
  if (!StreamEventTimestamp.safeParse(createdAt).success) {
    throw new Error("PostHog stream event has an invalid createdAt timestamp");
  }
  return new Date(createdAt).toISOString();
}

function projectBirthEvents(args: {
  batch: StreamDeliveryBatch;
  distinctId: string;
  projectId: string;
  workerName: string;
}) {
  const { batch, distinctId, projectId, workerName } = args;
  // Only the authentic root birth certificate owns the first-class group
  // records. Ordinary stream births must not repeatedly overwrite metadata.
  const projectBirth = batch.events.find((event) => {
    if (
      batch.path !== "/" ||
      event.path !== "/" ||
      event.ephemeral === true ||
      event.type !== "events.iterate.com/project/created" ||
      event.idempotencyKey !== internalStreamId("project-creation-terminal", projectId, "created")
    ) {
      return false;
    }
    return ProjectGroupBirthPayload.safeParse(event.payload).success;
  });
  if (projectBirth === undefined) return [];

  const project = ProjectGroupBirthPayload.parse(projectBirth.payload);
  const timestamp = normalizeEventTimestamp(projectBirth.createdAt);

  return [
    {
      event: "$groupidentify",
      properties: {
        $geoip_disable: true,
        $group_key: projectId,
        $group_set: {
          id: projectId,
          name: project.config.slug,
          slug: project.config.slug,
        },
        $group_type: "project",
        $is_server: true,
        distinct_id: distinctId,
      },
      timestamp,
      uuid: posthogUuid([
        "project-group-v1",
        workerName,
        projectId,
        batch.path,
        projectBirth.offset,
        timestamp,
      ]),
    },
    {
      event: "$set",
      properties: {
        $geoip_disable: true,
        $groups: { project: projectId },
        $is_server: true,
        $set: { name: `project:${project.config.slug}` },
        distinct_id: distinctId,
      },
      timestamp,
      uuid: posthogUuid(["project-person-v1", workerName, projectId]),
    },
  ];
}

function posthogEvents(args: {
  batch: StreamDeliveryBatch;
  projectId: string;
  workerName: string;
}) {
  const { batch, projectId, workerName } = args;
  // PostHog requires an identified event for Group Analytics linkage. One
  // synthetic identity per deployment/project lets machine-authored facts join
  // the same project group as browser activity without pretending that an
  // arbitrary human authored them. Do not resolve an organization for every
  // event: project is the stream feed's complete grouping boundary.
  const distinctId = `iterate-os-project:${posthogUuid([
    "project-identity-v1",
    workerName,
    projectId,
  ])}`;
  const groups = { project: projectId };
  // Capture-side filtering is deliberate defense in depth: durable lanes
  // never deliver ephemeral events, but never index one in PostHog either way.
  const durableEvents = batch.events.filter((event) => event.ephemeral !== true);
  const occurrences = durableEvents.map((event) => {
    const createdAt = normalizeEventTimestamp(event.createdAt);
    const streamEvent = truncateJsonToBytes(event, POSTHOG_STREAM_EVENT_MAX_JSON_BYTES);
    const eventUuid = eventIdentity(workerName, projectId, batch.path, batch.streamId, {
      createdAt,
      offset: event.offset,
    });
    return {
      // One fixed PostHog event name for every durable stream append. The
      // committed stream type stays on `stream_event_type` (and inside
      // `stream_event`) so analytics break down by type without exploding
      // PostHog's event catalogue.
      event: "stream:append",
      properties: {
        $geoip_disable: true,
        $groups: groups,
        $is_server: true,
        // PostHog's batch API documents distinct_id inside properties. A
        // malformed event can receive HTTP 200 but still be rejected later by
        // asynchronous ingestion, so keep the wire shape exact.
        distinct_id: distinctId,
        // This first-party feed mirrors the committed event rather than an
        // allowlist. Only an event above the explicit JSON byte boundary is
        // deterministically chopped, with that loss indexed alongside it.
        stream_event: streamEvent.value,
        stream_event_original_json_bytes: streamEvent.originalBytes,
        stream_event_truncated: streamEvent.truncated,
        stream_event_type: event.type,
        stream_path: batch.path,
      },
      // Source commit time is part of the occurrence identity. Keeping it
      // stable across retries matters because PostHog's deduplication sort
      // key includes the event date as well as UUID.
      timestamp: createdAt,
      uuid: eventUuid,
    };
  });
  return [...projectBirthEvents({ batch, distinctId, projectId, workerName }), ...occurrences];
}

/**
 * Submit one batch sent by a durable subscription through PostHog's public
 * batch-capture endpoint. A successful response acknowledges HTTP acceptance,
 * not completion of PostHog's asynchronous ingestion pipeline. The stream
 * owns transport retries; PostHog's asynchronous ingestion health is a
 * separate operational signal.
 *
 * https://posthog.com/docs/api/capture
 */
export async function capturePosthogStreamEventBatch(
  args: {
    apiKey: string;
    batch: StreamDeliveryBatch;
    projectId: string;
    workerName: string;
  },
  deps: { fetch?: typeof fetch } = {},
): Promise<void> {
  if (args.batch.events.length === 0) {
    throw new Error("PostHog stream delivery batch must contain an event");
  }
  await tracing.enterSpan("posthog.capture_stream_events", async (span) => {
    const streamPathId = posthogUuid([
      "stream-path-v1",
      args.workerName,
      args.projectId,
      args.batch.path,
    ]);
    span.setAttribute("iterate.project.id", args.projectId);
    span.setAttribute("iterate.stream.id", args.batch.streamId);
    span.setAttribute("iterate.stream.path_id", streamPathId);
    span.setAttribute("iterate.stream.event_count", args.batch.events.length);
    span.setAttribute("iterate.stream.delivery_id", args.batch.deliveryId);
    span.setAttribute("iterate.stream.delivery_attempt", args.batch.attempt);

    // Payload shaping is intentionally inside the span. Oversized stream
    // events are truncated before egress, and that CPU is part of delivery —
    // keeping it observable prevents a future regression from appearing as
    // unexplained time in the parent Stream.append invocation.
    const events = posthogEvents(args);
    const durableCount = events.filter((event) => event.event === "stream:append").length;
    span.setAttribute("iterate.stream.durable_event_count", durableCount);
    // An all-ephemeral delivery (or one that yields no PostHog rows) is a
    // successful no-op — do not fail event sending or call the capture API.
    if (events.length === 0) {
      return;
    }

    const response = await (deps.fetch ?? fetch)("https://eu.i.posthog.com/batch/", {
      // Deliberately omit optional `sent_at`: these are server-authoritative
      // source timestamps, so network timing must not skew them on retry.
      body: JSON.stringify({ api_key: args.apiKey, batch: events }),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "iterate-os/1.0.0",
      },
      method: "POST",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`PostHog batch capture rejected the request with HTTP ${response.status}`);
    }
    // Workerd requires response bodies to be consumed or cancelled before the
    // invocation finishes. The public endpoint has no synchronous per-event
    // ingestion result to interpret.
    await response.body?.cancel();
  });
}
