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
  INTEGRATION_DIRECTORY_STREAM_PATH,
  integrationConnectionStreamPath,
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

const TAIL_PAGE_SIZE = 200;

/**
 * A stream's events NEWEST FIRST, paged backwards from the journal head.
 *
 * Integration journals grow forever (one token-refreshed event per Gmail-token
 * expiry, one webhook per Slack message), but lifecycle questions ("is this
 * connection connected? what is its current token?") are answered by the most
 * recent few facts. Folding over this generator makes those reads O(tail) and
 * — because it is ONE iteration, not one fold per page — accumulators in the
 * consuming fold naturally span page boundaries.
 */
export async function* streamEventsNewestFirst(
  projectId: string | null,
  path: string,
): AsyncGenerator<StreamEvent> {
  const stream = integrationStreamStub(projectId, path);
  const { coreProcessorState } = await stream.runtimeState();
  let beforeOffset = coreProcessorState.maxOffset + 1;
  while (beforeOffset > 1) {
    // getEvents bounds are exclusive on both ends, so consecutive windows
    // (afterOffset, beforeOffset) tile the offset space with no gap/overlap.
    const afterOffset = Math.max(0, beforeOffset - 1 - TAIL_PAGE_SIZE);
    const page = await stream.getEvents({ afterOffset, beforeOffset });
    for (let index = page.length - 1; index >= 0; index -= 1) yield page[index]!;
    beforeOffset = afterOffset + 1;
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
 * externalId)`, latest claim wins; an unclaim clears it only when BOTH the
 * project and the connection match the live claim — one project can hold
 * several external accounts, and a stale connection's disconnect must not tear
 * down the claim a newer connection now owns. This is the provider-agnostic
 * generalization of the old Slack team directory (D4): the same fold serves
 * Slack team ids, GitHub installation ids, and any future provider.
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
    if (event.type === CONNECTION_CLAIMED_EVENT_TYPE) {
      if (typeof payload.connection !== "string") continue;
      claims.set(key, { connection: payload.connection, projectId: payload.projectId });
    } else if (
      event.type === CONNECTION_UNCLAIMED_EVENT_TYPE &&
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
  const events = await readAllStreamEvents(null, INTEGRATION_DIRECTORY_STREAM_PATH);
  return foldConnectionDirectory(events).get(directoryKey(slug, externalId)) ?? null;
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
  ).append(input.event);
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
