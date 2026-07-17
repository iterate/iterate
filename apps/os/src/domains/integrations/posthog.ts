import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";
import type { StreamEvent } from "../streams/schemas.ts";

export const POSTHOG_SUBSCRIPTION_KEY = "iterate-platform-posthog";
export const POSTHOG_STREAM_EVENT = "iterate stream event committed";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/batch/";
const StreamEventTimestamp = z.iso.datetime({ offset: true });
const ProjectGroupBirthPayload = z.object({
  config: z.object({
    slug: z.string(),
  }),
});
const StreamGroupBirthPayload = z.object({
  path: z.string(),
  projectId: z.string(),
});

/** The ordinary durable subscription appended to every new project stream. */
export function posthogSubscriptionEvent() {
  return {
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

type PostHogBatchEvent = {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid: string;
};

function projectGroupIdentifyEvent(args: {
  batch: StreamPushEventBatch;
  distinctId: string;
  projectId: string;
  workerName: string;
}): PostHogBatchEvent | undefined {
  const { batch, distinctId, projectId, workerName } = args;
  const projectBirth = batch.events.find((event) => {
    if (
      batch.path !== "/" ||
      event.path !== "/" ||
      event.type !== "events.iterate.com/project/created" ||
      event.idempotencyKey !== `project-created:${projectId}` ||
      event.ephemeral !== undefined ||
      event.metadata !== undefined ||
      event.source !== undefined
    ) {
      return false;
    }
    return ProjectGroupBirthPayload.safeParse(event.payload).success;
  });
  const streamBirth = batch.events.find((event) => {
    if (
      event.path !== batch.path ||
      event.offset !== 1 ||
      event.type !== "events.iterate.com/stream/created" ||
      event.idempotencyKey !== undefined ||
      event.ephemeral !== undefined ||
      event.metadata !== undefined ||
      event.source !== undefined
    ) {
      return false;
    }
    const birth = StreamGroupBirthPayload.safeParse(event.payload);
    return birth.success && birth.data.path === batch.path && birth.data.projectId === projectId;
  });
  const event = projectBirth ?? streamBirth;
  if (event === undefined) return undefined;

  const project =
    projectBirth === undefined ? undefined : ProjectGroupBirthPayload.parse(projectBirth.payload);

  const timestamp = normalizeEventTimestamp(event.createdAt);
  // PostHog recommends an immutable ID as the group key and uses `name` as
  // the UI label. This value is explicitly the slug at project creation;
  // project slugs can change independently later.
  // https://posthog.com/docs/product-analytics/group-analytics
  return {
    event: "$groupidentify",
    properties: {
      $geoip_disable: true,
      $group_key: projectId,
      $group_set:
        project === undefined
          ? { id: projectId }
          : { id: projectId, name: project.config.slug, slug: project.config.slug },
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
      event.offset,
      timestamp,
    ]),
  };
}

function posthogEvents(args: {
  batch: StreamPushEventBatch;
  projectId: string;
  workerName: string;
}): PostHogBatchEvent[] {
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
  const occurrences = batch.events.map((event) => {
    const createdAt = normalizeEventTimestamp(event.createdAt);
    const eventUuid = eventIdentity(workerName, projectId, batch.path, {
      createdAt,
      offset: event.offset,
    });
    return {
      event: POSTHOG_STREAM_EVENT,
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
        // The complete committed event is intentional. This first-party feed
        // is an event mirror, not an allowlisted operational projection.
        stream_event: event,
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
  if (args.batch.events.length === 0) return;
  const events = posthogEvents(args);
  await tracing.enterSpan("posthog.capture_stream_events", async (span) => {
    const streamId = posthogUuid(["stream-v1", args.workerName, args.projectId, args.batch.path]);
    span.setAttribute("iterate.project.id", args.projectId);
    span.setAttribute("iterate.stream.id", streamId);
    span.setAttribute("iterate.stream.event_count", args.batch.events.length);
    span.setAttribute("iterate.stream.delivery_id", args.batch.deliveryId);
    span.setAttribute("iterate.stream.delivery_attempt", args.batch.attempt);

    const response = await (deps.fetch ?? fetch)(POSTHOG_CAPTURE_URL, {
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
