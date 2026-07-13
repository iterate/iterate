// itx-side stream access for the integrations domain.
//
// These helpers dial the Stream Durable Objects directly (same shape as
// StreamRpcTarget's stub minting) so the domain modules do not import the
// RpcTarget layer. All callers are itx workers acting with internal
// authority; caller-facing confinement stays in rpc-targets.ts.

import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  CONNECTION_CLAIMED_EVENT_TYPE,
  CONNECTION_UNCLAIMED_EVENT_TYPE,
  integrationConnectionStreamPath,
  integrationDirectoryStreamPath,
} from "./utils.ts";

export function integrationStreamStub(projectId: string | null, path: string) {
  return itxEnv.STREAM.getByName(
    DurableObjectNameCodec.stringify({ projectId, path }, { allowNullProjectId: true }),
  );
}

/** All events of one stream, oldest first, paged through the getEvents cursor. */
async function readAllStreamEvents(projectId: string | null, path: string): Promise<StreamEvent[]> {
  const stream = integrationStreamStub(projectId, path);
  const events: StreamEvent[] = [];
  let afterOffset = 0;
  for (;;) {
    const page = await stream.getEvents({ afterOffset, limit: 500 });
    events.push(...page);
    if (page.length < 500) return events;
    afterOffset = page[page.length - 1]!.offset;
  }
}

/**
 * The newest accepted event of the requested types. The ordinary path reads
 * one row; only a rejected newest row falls back to bounded backward pages.
 */
export async function latestStreamEvent(
  projectId: string | null,
  path: string,
  eventTypes: readonly string[],
  accepts?: (event: StreamEvent) => boolean,
): Promise<StreamEvent | undefined> {
  const stream = integrationStreamStub(projectId, path);
  const newest = (await stream.getEvents({ eventTypes, limit: 1, order: "desc" }))[0];
  if (newest === undefined || accepts === undefined || accepts(newest)) return newest;

  let beforeOffset = newest.offset;
  for (;;) {
    const page = await stream.getEvents({
      beforeOffset,
      eventTypes,
      limit: 500,
      order: "desc",
    });
    const accepted = page.find(accepts);
    if (accepted !== undefined || page.length < 500) return accepted;
    beforeOffset = page.at(-1)!.offset;
  }
}

/** One project+connection that owns a provider-side external id. */
type ConnectionClaim = { connection: string; projectId: string };

/**
 * Folds one claim from its integration-directory bucket. Latest claim wins;
 * an unclaim clears it only when BOTH project and connection match the live
 * claim, so a stale connection's disconnect cannot tear down a newer owner.
 */
export function foldConnectionClaim(
  events: readonly StreamEvent[],
  key: { externalId: string; slug: string },
): ConnectionClaim | null {
  let claim: ConnectionClaim | null = null;
  for (const event of events) {
    const payload = event.payload as {
      connection?: unknown;
      externalId?: unknown;
      projectId?: unknown;
      slug?: unknown;
    };
    if (
      payload?.slug !== key.slug ||
      payload.externalId !== key.externalId ||
      typeof payload.projectId !== "string"
    ) {
      continue;
    }
    if (event.type === CONNECTION_CLAIMED_EVENT_TYPE) {
      if (typeof payload.connection !== "string") continue;
      claim = { connection: payload.connection, projectId: payload.projectId };
    } else if (
      event.type === CONNECTION_UNCLAIMED_EVENT_TYPE &&
      claim?.projectId === payload.projectId &&
      claim.connection === payload.connection
    ) {
      claim = null;
    }
  }
  return claim;
}

/** Resolve which project+connection a validly-signed webhook belongs to, by
 * the provider slug and the external id extracted from its payload. */
export async function lookupConnectionClaim(
  slug: string,
  externalId: string,
): Promise<ConnectionClaim | null> {
  const events = await readAllStreamEvents(null, integrationDirectoryStreamPath(slug, externalId));
  return foldConnectionClaim(events, { externalId, slug });
}

/** Whether a provider external id has a live directory claim for a project.
 * Platform credential mints use this to prevent a project-authored refresh
 * configuration from acting as another project's provider installation. */
export async function isConnectionClaimedByProject(input: {
  externalId: string;
  projectId: string;
  slug: string;
}): Promise<boolean> {
  const claim = await lookupConnectionClaim(input.slug, input.externalId);
  return claim?.projectId === input.projectId;
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
 * connection's stream. `ignored` (no live claim) lets the door ACK-and-drop.
 * This is the generic core of the webhook door (D4): per-provider code does
 * only the signature verify, external-id extract, and event shaping; routing is
 * one function for every integration.
 */
export async function routeIntegrationWebhook(input: {
  event: { idempotencyKey: string; payload: Record<string, unknown>; type: string };
  externalId: string;
  slug: string;
}): Promise<RouteIntegrationWebhookResult> {
  const claim = await lookupConnectionClaim(input.slug, input.externalId);
  if (claim === null) return { ignored: "external-id-not-claimed", ok: true };
  await integrationStreamStub(
    claim.projectId,
    integrationConnectionStreamPath(input.slug, claim.connection),
  ).appendAck(input.event);
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
  const first = inputs[0];
  if (first === undefined) return;
  if (inputs.some((input) => input.slug !== first.slug || input.externalId !== first.externalId)) {
    throw new Error("One directory append cannot span integration external ids.");
  }
  await integrationStreamStub(
    null,
    integrationDirectoryStreamPath(first.slug, first.externalId),
  ).appendAck(
    ...inputs.map((input) => ({
      type: input.claimed ? CONNECTION_CLAIMED_EVENT_TYPE : CONNECTION_UNCLAIMED_EVENT_TYPE,
      payload: {
        connection: input.connection,
        externalId: input.externalId,
        projectId: input.projectId,
        slug: input.slug,
      },
    })),
  );
}
