// itx-side stream access for the integrations domain.
//
// These helpers dial the Stream Durable Objects directly (same shape as
// StreamRpcTarget's stub minting) so the domain modules do not import the
// RpcTarget layer. All callers are itx workers acting with internal
// authority; caller-facing confinement stays in rpc-targets.ts.

import type { StreamEvent } from "iterate/processors";
import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { INTEGRATION_DIRECTORY_STREAM_PATH, integrationConnectionStreamPath } from "./utils.ts";

export function integrationStreamStub(projectId: string | null, path: string) {
  return itxEnv.STREAM.getByName(
    DurableObjectNameCodec.stringify({ projectId, path }, { allowNullProjectId: true }),
  );
}

/** All selected events of one stream, oldest first, paged through the getEvents cursor. */
async function readAllStreamEvents(
  projectId: string | null,
  path: string,
  eventTypes: readonly string[],
): Promise<StreamEvent[]> {
  const stream = integrationStreamStub(projectId, path);
  const events: StreamEvent[] = [];
  let afterOffset = 0;
  for (;;) {
    const page = await stream.getEvents({ afterOffset, eventTypes, limit: 500 });
    events.push(...page);
    if (page.length < 500) return events;
    afterOffset = page[page.length - 1]!.offset;
  }
}

const FILTERED_PAGE_SIZE = 500;
const CONNECTION_DIRECTORY_EVENT_TYPES = [
  "events.iterate.com/integration/connection-claimed",
  "events.iterate.com/integration/connection-unclaimed",
];

/**
 * The latest event matching any of the requested types.
 *
 * Integration journals grow forever (one webhook per GitHub or Slack event),
 * while lifecycle questions only need connected/disconnected facts. Filtering
 * in Stream storage keeps unrelated event chunks and one-RPC-per-tail-page
 * round trips out of the status path. Page forward in the unlikely case a
 * connection has more than 500 lifecycle transitions so latest still wins.
 */
export async function latestStreamEventOfTypes(
  projectId: string | null,
  path: string,
  eventTypes: readonly string[],
): Promise<StreamEvent | null> {
  const stream = integrationStreamStub(projectId, path);
  let afterOffset = 0;
  let latest: StreamEvent | null = null;
  for (;;) {
    const page = await stream.getEvents({ afterOffset, eventTypes, limit: FILTERED_PAGE_SIZE });
    if (page.length === 0) return latest;
    latest = page.at(-1)!;
    if (page.length < FILTERED_PAGE_SIZE) return latest;
    afterOffset = latest.offset;
  }
}

/** One project+connection that owns a provider-side external id. */
type ConnectionClaim = { connection: string; projectId: string };

/** Directory key: `(slug, externalId)` flattened. The external id is only
 * unique WITHIN a provider (a Slack team id and a GitHub installation id could
 * collide as bare strings), so the slug is part of the key. */
function directoryKey(slug: string, externalId: string): string {
  return `${slug} ${externalId}`;
}

/**
 * Folds the deployment-wide integration directory: for each `(slug,
 * externalId)`, the first live project owner wins. That project may update the
 * connection name; another project can claim the id only after a matching
 * unclaim clears it. Requiring BOTH the project and connection on an unclaim
 * also prevents a stale connection's disconnect from tearing down the claim a
 * newer connection now owns. This is the provider-agnostic generalization of
 * the old Slack team directory (D4): the same fold serves Slack team ids,
 * GitHub installation ids, and any future provider.
 */
export function foldConnectionDirectory(
  events: readonly StreamEvent[],
): Map<string, ConnectionClaim> {
  const claims = new Map<string, ConnectionClaim>();
  for (const event of events) {
    const payload = event.payload as {
      connection?: unknown;
      externalId?: unknown;
      projectId?: unknown;
      slug?: unknown;
    };
    if (
      typeof payload?.slug !== "string" ||
      typeof payload?.externalId !== "string" ||
      typeof payload?.projectId !== "string"
    ) {
      continue;
    }
    const key = directoryKey(payload.slug, payload.externalId);
    if (event.type === "events.iterate.com/integration/connection-claimed") {
      if (typeof payload.connection !== "string") continue;
      const existingClaim = claims.get(key);
      if (existingClaim === undefined || existingClaim.projectId === payload.projectId) {
        claims.set(key, { connection: payload.connection, projectId: payload.projectId });
      }
    } else if (
      event.type === "events.iterate.com/integration/connection-unclaimed" &&
      claims.get(key)?.projectId === payload.projectId &&
      claims.get(key)?.connection === payload.connection
    ) {
      claims.delete(key);
    }
  }
  return claims;
}

/** Resolve which project+connection a validly-signed webhook belongs to, by
 * the provider slug and the external id extracted from its payload. */
export async function lookupConnectionClaim(
  slug: string,
  externalId: string,
): Promise<ConnectionClaim | null> {
  // The directory stream also contains ordinary stream lifecycle events. Webhook
  // ingress is bursty, so hydrating every unrelated event here multiplies one
  // GitHub delivery into a large SQLite/body-read workload on a single DO.
  // Storage-side event-type filtering leaves only the tiny claim history.
  const events = await readAllStreamEvents(
    null,
    INTEGRATION_DIRECTORY_STREAM_PATH,
    CONNECTION_DIRECTORY_EVENT_TYPES,
  );
  return foldConnectionDirectory(events).get(directoryKey(slug, externalId)) ?? null;
}

/** The outcome of routing one inbound webhook: delivered to a connection, or
 * `ignored` because no project has claimed its external id (the caller ACKs the
 * ignored case with a 200 — see the webhook handlers' cardinal rule). */
type RouteIntegrationWebhookResult =
  | { connection: string; ok: true; projectId: string }
  | { ignored: string; ok: true };

/**
 * Route one validly-signed webhook to the project + connection that claimed its
 * `(slug, externalId)`, by appending a provider-shaped event to that
 * connection's stream. This function deliberately appends ONLY the ingress
 * fact: connection setup appends any router-created event and subscription. `ignored` (no
 * live claim) lets the door ACK-and-drop. This is the generic core of the
 * webhook door (D4): per-provider code does only the signature verify,
 * external-id extract, and event shaping; routing is one function for every
 * integration.
 */
export async function routeIntegrationWebhook(input: {
  event: { idempotencyKey: string; payload: Record<string, unknown>; type: string };
  externalId: string;
  /**
   * Birth certificate that must already exist on the claimed connection
   * stream. Webhook routers pass this so ingress can never commit work before
   * the processor has been explicitly created. Providers without an inbound
   * stream processor (currently GitHub) omit it.
   */
  routerCreatedEventType?: string;
  slug: string;
}): Promise<RouteIntegrationWebhookResult> {
  const claim = await lookupConnectionClaim(input.slug, input.externalId);
  if (claim === null) return { ignored: "external-id-not-claimed", ok: true };
  const streamPath = integrationConnectionStreamPath(input.slug, claim.connection);
  if (
    input.routerCreatedEventType !== undefined &&
    (await latestStreamEventOfTypes(claim.projectId, streamPath, [
      input.routerCreatedEventType,
    ])) === null
  ) {
    throw new Error(
      `${input.slug} router ${claim.connection} for project ${claim.projectId} has not been created`,
    );
  }
  await integrationStreamStub(claim.projectId, streamPath).append({
    ...input.event,
    // Preserve the trusted routing decision on the durable fact. Downstream
    // userspace can select the exact account that received the webhook
    // instead of accidentally acting through the project's first connection.
    payload: { ...input.event.payload, connection: claim.connection },
  });
  return { connection: claim.connection, ok: true, projectId: claim.projectId };
}

/**
 * Append a claim (or unclaim) to the directory. Called synchronously by
 * connect/disconnect (D4): the caller must first reject a conflicting claim
 * with `external_id_already_claimed` (see connect-flows). Flows that MOVE an
 * external id between projects (telegram's steal) use the batch variant so
 * the unclaim and the new claim commit atomically.
 */
export async function appendConnectionDirectoryEvent(input: {
  claimed: boolean;
  connection: string;
  externalId: string;
  projectId: string;
  slug: string;
}): Promise<void> {
  await appendConnectionDirectoryEvents([input]);
}

/**
 * Append several claim/unclaim facts to the directory in ONE stream append —
 * one commit, so a fold can never observe a state between them. This is what
 * makes a steal safe for a bot with live traffic: [unclaim old, claim new] as
 * a batch leaves no unclaimed window where the door would ACK-and-drop
 * inbound events that Telegram never retries.
 */
export async function appendConnectionDirectoryEvents(
  inputs: readonly {
    claimed: boolean;
    connection: string;
    externalId: string;
    projectId: string;
    slug: string;
  }[],
): Promise<void> {
  await integrationStreamStub(null, INTEGRATION_DIRECTORY_STREAM_PATH).append(
    ...inputs.map((input) => ({
      type: input.claimed
        ? "events.iterate.com/integration/connection-claimed"
        : "events.iterate.com/integration/connection-unclaimed",
      payload: {
        connection: input.connection,
        externalId: input.externalId,
        projectId: input.projectId,
        slug: input.slug,
      },
    })),
  );
}
