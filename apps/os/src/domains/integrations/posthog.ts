import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import {
  PROJECT_WORKER_SUBSCRIPTION_KEY,
  type SubscriptionConfiguredPayload,
} from "../streams/core-processor-contract.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";

export const POSTHOG_SUBSCRIPTION_KEY = "iterate-platform-posthog";
export const POSTHOG_STREAM_EVENT = "iterate stream event committed";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/batch/";
const StreamEventTimestamp = z.iso.datetime({ offset: true });
const ProjectGroupBirthPayload = z.object({
  config: z.object({
    slug: z.string().trim().min(1).max(50),
  }),
});

const CanonicalPosthogSubscriptionPayload = z.strictObject({
  subscriptionKey: z.literal(POSTHOG_SUBSCRIPTION_KEY),
  description: z.literal("Iterate's first-party, all-event PostHog feed"),
  delivery: z.strictObject({
    mode: z.literal("push"),
    expression: z.tuple([
      z.literal("integrations"),
      z.literal("posthog"),
      z.literal("processEventBatch"),
    ]),
  }),
  deliver: z.literal("all"),
  onPoison: z.literal("park"),
});

const CanonicalProjectWorkerSubscriptionPayload = z.strictObject({
  subscriptionKey: z.literal(PROJECT_WORKER_SUBSCRIPTION_KEY),
  delivery: z.strictObject({
    mode: z.literal("push"),
    expression: z.tuple([z.literal("processEventBatch")]),
  }),
  deliver: z.literal("all"),
  onPoison: z.literal("skip"),
});

// PostHog requires identified events for group linkage. Keep one synthetic
// identity per deployment/project: this avoids creating identities per stream
// while preventing one project's distinct-id limiter from stalling every
// project's durable feed.
/** The one reserved subscription appended to every project stream. */
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
      onPoison: "park",
    } satisfies SubscriptionConfiguredPayload,
  };
}

function hasCanonicalPosthogPayload(event: Pick<StreamEventInput, "type" | "payload">): boolean {
  return (
    event.type === "events.iterate.com/stream/subscription-configured" &&
    CanonicalPosthogSubscriptionPayload.safeParse(event.payload).success
  );
}

/** True only for the platform-owned configuration as committed on its own stream. */
function isFirstPartyPosthogSubscriptionConfiguration(event: StreamEventInput): boolean {
  const canonical = posthogSubscriptionEvent();
  return (
    event.idempotencyKey === canonical.idempotencyKey &&
    event.ephemeral === undefined &&
    event.metadata === undefined &&
    event.source === undefined &&
    hasCanonicalPosthogPayload(event)
  );
}

/** Platform birth/subscription facts are local control state, never cross-postable product data. */
export function isPlatformLocalControlEvent(event: StreamEventInput): boolean {
  if (event.type === "events.iterate.com/project/created") return true;
  if (!event.type.startsWith("events.iterate.com/stream/subscription-")) return false;
  const key = event.payload?.subscriptionKey;
  return key === POSTHOG_SUBSCRIPTION_KEY || key === PROJECT_WORKER_SUBSCRIPTION_KEY;
}

function isCanonicalProjectWorkerConfiguration(event: StreamEventInput): boolean {
  return (
    event.type === "events.iterate.com/stream/subscription-configured" &&
    event.idempotencyKey === undefined &&
    event.ephemeral === undefined &&
    event.metadata === undefined &&
    event.source === undefined &&
    CanonicalProjectWorkerSubscriptionPayload.safeParse(event.payload).success
  );
}

function hasCanonicalProjectWorkerDeliveryEnvelope(batch: StreamPushEventBatch): boolean {
  return (
    batch.projectId !== null &&
    batch.subscriptionKey === PROJECT_WORKER_SUBSCRIPTION_KEY &&
    batch.configuredEvent.offset === 2 &&
    batch.configuredEvent.path === batch.path &&
    isCanonicalProjectWorkerConfiguration(batch.configuredEvent)
  );
}

/** Reject any userspace subscription trying to replay the platform project-worker sink. */
export function assertCanonicalProjectWorkerDeliveryEnvelope(batch: StreamPushEventBatch): void {
  if (!hasCanonicalProjectWorkerDeliveryEnvelope(batch)) {
    throw new Error("project worker dispatch only accepts Iterate's canonical stream subscription");
  }
}

/** Only the stream's immutable offset-one birth certificate provisions its feed. */
export function batchContainsCanonicalStreamCreated(batch: StreamPushEventBatch): boolean {
  return (
    hasCanonicalProjectWorkerDeliveryEnvelope(batch) &&
    batch.events.some(
      (event) =>
        event.offset === 1 &&
        event.path === batch.path &&
        event.source === undefined &&
        event.type === "events.iterate.com/stream/created" &&
        event.payload?.projectId === batch.projectId &&
        event.payload?.path === batch.path,
    )
  );
}

/** Reject any ordinary push subscription trying to route through the first-party sink. */
export function assertCanonicalPosthogDeliveryEnvelope(batch: StreamPushEventBatch): void {
  if (
    batch.subscriptionKey !== POSTHOG_SUBSCRIPTION_KEY ||
    batch.configuredEvent.path !== batch.path ||
    !hasCanonicalPosthogPayload(batch.configuredEvent)
  ) {
    throw new Error("PostHog ingestion only accepts Iterate's canonical stream subscription");
  }
}

/**
 * Reserved subscription configuration is installed inside the Stream Durable
 * Object. Public append may only perform explicit operator resume/redrive
 * actions; there is no import or compatibility lane for platform facts.
 */
export function assertPlatformEventWriteAllowed(
  events: readonly StreamEventInput[],
  options: {
    authority: "admin" | "userspace";
    projectId: string | null;
  },
): void {
  const canonical = posthogSubscriptionEvent();
  for (const event of events) {
    if (event.type === "events.iterate.com/project/created") {
      throw new Error("project birth is managed by Iterate");
    }
    if (isCanonicalProjectWorkerConfiguration(event)) {
      if (options.projectId === null) {
        throw new Error("the project worker birth subscription requires a project stream");
      }
      throw new Error("the project worker birth subscription is managed by Iterate");
    }
    const isCanonical = isFirstPartyPosthogSubscriptionConfiguration(event);
    if (isCanonical) {
      if (options.projectId === null) {
        throw new Error("the first-party PostHog subscription requires a project stream");
      }
      throw new Error("the first-party PostHog subscription is managed by Iterate");
    }
    if (event.idempotencyKey === canonical.idempotencyKey) {
      throw new Error("the first-party PostHog idempotency key has a noncanonical owner");
    }
    if (!event.type.startsWith("events.iterate.com/stream/subscription-")) continue;
    const key = event.payload?.subscriptionKey;
    const isResume = event.type === "events.iterate.com/stream/subscription-resumed";
    const isCursorSet = event.type === "events.iterate.com/stream/subscription-cursor-set";
    const isAllowedLifecycle =
      (key === POSTHOG_SUBSCRIPTION_KEY || key === PROJECT_WORKER_SUBSCRIPTION_KEY) &&
      event.source === undefined &&
      event.metadata === undefined &&
      event.ephemeral === undefined &&
      options.authority === "admin" &&
      (isResume || (key === POSTHOG_SUBSCRIPTION_KEY && isCursorSet));
    if (isAllowedLifecycle) continue;
    if (key === PROJECT_WORKER_SUBSCRIPTION_KEY) {
      throw new Error("the project worker birth subscription is managed by Iterate");
    }
    const delivery = event.payload?.delivery;
    const expression =
      typeof delivery === "object" && delivery !== null && "expression" in delivery
        ? delivery.expression
        : undefined;
    const routesToPosthog =
      Array.isArray(expression) && expression[0] === "integrations" && expression[1] === "posthog";
    const routesToProjectWorker =
      Array.isArray(expression) && expression.length === 1 && expression[0] === "processEventBatch";
    if (key === POSTHOG_SUBSCRIPTION_KEY) {
      throw new Error("the first-party PostHog subscription is managed by Iterate");
    }
    if (routesToPosthog) {
      throw new Error("the first-party PostHog delivery route is managed by Iterate");
    }
    if (routesToProjectWorker) {
      throw new Error("the project worker delivery route is managed by Iterate");
    }
  }
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
  // deduplication is best-effort, so the source stream remains authoritative.
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

function canonicalEventTimestamp(createdAt: string): string {
  if (!StreamEventTimestamp.safeParse(createdAt).success) {
    throw new Error("PostHog stream event has an invalid createdAt timestamp");
  }
  return new Date(createdAt).toISOString();
}

type PostHogBatchEvent = {
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid: string;
};

function projectGroupIdentifyEvent(args: {
  batch: StreamPushEventBatch;
  distinctId: string;
  event: StreamEvent;
  projectId: string;
  workerName: string;
}): PostHogBatchEvent | undefined {
  const { batch, distinctId, event, projectId, workerName } = args;
  if (
    batch.path !== "/" ||
    event.path !== "/" ||
    event.type !== "events.iterate.com/project/created" ||
    event.idempotencyKey !== `project-created:${projectId}` ||
    event.ephemeral !== undefined ||
    event.metadata !== undefined ||
    event.source !== undefined
  ) {
    return undefined;
  }
  const birth = ProjectGroupBirthPayload.safeParse(event.payload);
  if (!birth.success) return undefined;

  const timestamp = canonicalEventTimestamp(event.createdAt);
  return {
    distinct_id: distinctId,
    event: "$groupidentify",
    properties: {
      $geoip_disable: true,
      $group_key: projectId,
      $group_set: {
        id: projectId,
        slug: birth.data.config.slug,
      },
      $group_type: "project",
      $is_server: true,
    },
    timestamp,
    uuid: posthogUuid(["project-group-v1", workerName, projectId, timestamp]),
  };
}

function posthogEvents(args: {
  batch: StreamPushEventBatch;
  projectId: string;
  workerName: string;
}): PostHogBatchEvent[] {
  const { batch, projectId, workerName } = args;
  const distinctId = `iterate-os-project:${posthogUuid([
    "project-identity-v1",
    workerName,
    projectId,
  ])}`;
  // Stream paths may be unbounded and user-controlled, so expose only a
  // stable opaque identifier rather than copying the path into PostHog.
  const streamId = posthogUuid(["stream-v1", workerName, projectId, batch.path]);
  const occurrences = batch.events.map((event) => {
    const createdAt = canonicalEventTimestamp(event.createdAt);
    // Event types are validated bounded identifiers at the append boundary.
    // Unlike payload/metadata/path, the exact identifier is deliberately
    // exported as the searchable operational schema name.
    const eventUuid = eventIdentity(workerName, projectId, batch.path, {
      createdAt,
      offset: event.offset,
    });
    return {
      distinct_id: distinctId,
      event: POSTHOG_STREAM_EVENT,
      properties: {
        $geoip_disable: true,
        $groups: { project: projectId },
        $is_server: true,
        project_id: projectId,
        stream_event_created_at: createdAt,
        stream_event_ephemeral: event.ephemeral === true,
        stream_event_offset: event.offset,
        stream_event_type: event.type,
        stream_event_uuid: eventUuid,
        stream_max_offset: batch.streamMaxOffset,
        stream_id: streamId,
        worker_name: workerName,
      },
      // This is an operational occurrence index, including historical
      // replay—not a second payload store. The exact source is the stream
      // coordinate above. Keeping properties bounded prevents PostHog's
      // post-enrichment Kafka limit from silently dropping an event after
      // capture accepted it:
      // https://github.com/PostHog/posthog/blob/4aee1e98fd247603f71beccb025938eea5436352/products/ingestion/skills/resolving-ingestion-warnings/references/fixing-message-size-too-large.md
      // Source commit time is part of the occurrence identity. Keeping it
      // stable across retries matters because PostHog's deduplication sort
      // key includes the event date as well as UUID.
      timestamp: createdAt,
      uuid: eventUuid,
    };
  });
  const groupIdentify = batch.events
    .map((event) => projectGroupIdentifyEvent({ batch, distinctId, event, projectId, workerName }))
    .find((event) => event !== undefined);
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
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`PostHog batch capture rejected the request with HTTP ${response.status}`);
    }
    // Workerd requires response bodies to be consumed or cancelled before the
    // invocation finishes. The public endpoint has no synchronous per-event
    // ingestion result to interpret.
    await response.body?.cancel().catch(() => undefined);
  });
}
