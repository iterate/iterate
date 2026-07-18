import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { StreamPushEventBatch } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import { truncateJsonToBytes } from "./truncate-json.ts";

export const POSTHOG_STREAM_EVENT_MAX_JSON_BYTES = 100 * 1_024;
const POSTHOG_STREAM_FEED_WORKER_NAME = "os-prd";

const StreamEventTimestamp = z.iso.datetime({ offset: true });
const ProjectGroupBirthPayload = z.object({
  config: z.object({
    slug: z.string(),
  }),
});

/** The ordinary durable subscription appended to every new project stream. */
export function posthogSubscriptionEvent() {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    // Bump when the subscription payload changes so new stream births land
    // the revised config. Existing streams still rely on capture-side filtering
    // until they are recreated or reconfigured.
    idempotencyKey: "iterate-platform-posthog-subscription-v2",
    payload: {
      subscriptionKey: "iterate-platform-posthog",
      description: "Iterate's first-party durable-event PostHog feed",
      delivery: {
        mode: "push",
        expression: ["integrations", "posthog", "processEventBatch"],
      },
      deliver: "all",
      // High-volume transient rows (LLM chunks, progress ticks) stay off the
      // analytics feed; durable product facts are what PostHog should index.
      includeEphemeral: false,
      onPoison: "park",
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
  event: Pick<StreamEvent, "offset"> & { createdAt: string },
): string {
  // Deployment identity and the durable stream coordinate distinguish
  // preview/prd and every committed row, while an exact at-least-once
  // redelivery keeps the same PostHog UUID. PostHog's ingestion-side UUID
  // deduplication is best-effort, so the source stream remains authoritative:
  // https://posthog.com/docs/api/capture
  // JSON-array encoding is unambiguous even when a user-controlled path
  // contains `/`. A recovered row at the same coordinate is the same source
  // occurrence.
  return posthogUuid([
    "stream-event-v1",
    workerName,
    projectId,
    path,
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

function projectGroupIdentifyEvent(args: {
  batch: StreamPushEventBatch;
  distinctId: string;
  projectId: string;
  workerName: string;
}) {
  const { batch, distinctId, projectId, workerName } = args;
  // Only the authentic root birth certificate owns the complete first-class
  // project group record. Pre-rollout projects intentionally get no partial
  // compatibility record or mutable directory lookup here.
  const projectBirth = batch.events.find((event) => {
    if (
      batch.path !== "/" ||
      event.path !== "/" ||
      event.type !== "events.iterate.com/project/created" ||
      event.idempotencyKey !== `project-created:${projectId}`
    ) {
      return false;
    }
    return ProjectGroupBirthPayload.safeParse(event.payload).success;
  });
  if (projectBirth === undefined) return undefined;

  const project = ProjectGroupBirthPayload.parse(projectBirth.payload);

  const timestamp = normalizeEventTimestamp(projectBirth.createdAt);
  // PostHog recommends an immutable ID as the group key and uses `name` as
  // the UI label. This value is explicitly the slug at project creation;
  // project slugs can change independently later.
  // https://posthog.com/docs/product-analytics/group-analytics
  return {
    event: "$groupidentify",
    properties: {
      $geoip_disable: true,
      $group_key: projectId,
      $group_set: { id: projectId, name: project.config.slug, slug: project.config.slug },
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
  };
}

function posthogEvents(args: {
  batch: StreamPushEventBatch;
  projectId: string;
  workerName: string;
}) {
  const { batch, projectId, workerName } = args;
  // PostHog requires identified events for group linkage. Keep one synthetic
  // identity per deployment/project: this avoids creating identities per stream
  // while preventing one project's distinct-id limiter from stalling every
  // project's durable feed.
  const distinctId = `iterate-os-project:${posthogUuid([
    "project-identity-v1",
    workerName,
    projectId,
  ])}`;
  const streamId = posthogUuid(["stream-v1", workerName, projectId, batch.path]);
  // Capture-side filter is deliberate defense in depth: subscriptions born
  // before includeEphemeral flipped to false may still deliver ephemeral rows.
  // Never index those in PostHog.
  const durableEvents = batch.events.filter((event) => event.ephemeral !== true);
  const occurrences = durableEvents.map((event) => {
    const createdAt = normalizeEventTimestamp(event.createdAt);
    const streamEvent = truncateJsonToBytes(event, POSTHOG_STREAM_EVENT_MAX_JSON_BYTES);
    const eventUuid = eventIdentity(workerName, projectId, batch.path, {
      createdAt,
      offset: event.offset,
    });
    return {
      event: "stream:append",
      properties: {
        $geoip_disable: true,
        $groups: { project: projectId },
        $is_server: true,
        // PostHog's batch API documents distinct_id inside properties. A
        // malformed event can receive HTTP 200 but still be rejected later by
        // asynchronous ingestion, so keep the wire shape exact.
        distinct_id: distinctId,
        project_id: projectId,
        stream_event_created_at: createdAt,
        stream_event_ephemeral: event.ephemeral === true,
        stream_event_offset: event.offset,
        stream_event_type: event.type,
        stream_event_uuid: eventUuid,
        // This first-party feed mirrors the committed event rather than an
        // allowlist. Only an event above the explicit JSON byte boundary is
        // deterministically chopped, with that loss indexed alongside it.
        stream_event: streamEvent.value,
        stream_event_original_json_bytes: streamEvent.originalBytes,
        stream_event_truncated: streamEvent.truncated,
        stream_max_offset: batch.streamMaxOffset,
        stream_id: streamId,
        stream_path: batch.path,
        worker_name: workerName,
      },
      // Source commit time is part of the occurrence identity. Keeping it
      // stable across retries matters because PostHog's deduplication sort
      // key includes the event date as well as UUID.
      timestamp: createdAt,
      uuid: eventUuid,
    };
  });
  const groupIdentify = projectGroupIdentifyEvent({ batch, distinctId, projectId, workerName });
  return groupIdentify === undefined ? occurrences : [groupIdentify, ...occurrences];
}

/**
 * Submit one durable subscriber batch through PostHog's supported public
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
    batch: StreamPushEventBatch;
    projectId: string;
    workerName: string;
  },
  deps: { fetch?: typeof fetch } = {},
): Promise<void> {
  // The complete durable feed is a production observability surface. Preview
  // and local deployments generate synthetic projects and streams at CI scale;
  // exporting those facts adds no production signal and can dominate PostHog
  // usage. WORKER_SELF is the reviewed deployment identity from envs.ts.
  if (args.workerName !== POSTHOG_STREAM_FEED_WORKER_NAME) return;
  if (args.batch.events.length === 0) {
    throw new Error("PostHog stream delivery batch must contain an event");
  }
  await tracing.enterSpan("posthog.capture_stream_events", async (span) => {
    const streamId = posthogUuid(["stream-v1", args.workerName, args.projectId, args.batch.path]);
    span.setAttribute("iterate.project.id", args.projectId);
    span.setAttribute("iterate.stream.id", streamId);
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
    // successful no-op — do not fail the subscriber or call the capture API.
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
