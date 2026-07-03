// Itx-side stream access for the integrations domain.
//
// These helpers dial the Stream Durable Objects directly (same shape as
// StreamRpcTarget's stub minting) so the domain modules do not import the
// RpcTarget layer. All callers are itx workers acting with internal
// authority; caller-facing confinement stays in rpc-targets.ts.

import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { StreamEvent } from "../../types.ts";
import {
  SLACK_TEAM_CLAIMED_EVENT_TYPE,
  SLACK_TEAM_DIRECTORY_STREAM_PATH,
  SLACK_TEAM_UNCLAIMED_EVENT_TYPE,
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
 * Folds the deployment-wide Slack team directory: latest claim wins per team,
 * an unclaim from the claiming project clears it. A claim names the project
 * AND the connection that owns the team; claim events without a string
 * `connection` are ignored (clean break — pre-connections claims do not fold).
 */
function foldSlackTeamDirectory(
  events: readonly StreamEvent[],
): Map<string, { connection: string; projectId: string }> {
  const claims = new Map<string, { connection: string; projectId: string }>();
  for (const event of events) {
    const payload = event.payload as {
      connection?: unknown;
      projectId?: unknown;
      teamId?: unknown;
    };
    if (typeof payload?.teamId !== "string" || typeof payload?.projectId !== "string") continue;
    if (event.type === SLACK_TEAM_CLAIMED_EVENT_TYPE) {
      if (typeof payload.connection !== "string") continue;
      claims.set(payload.teamId, {
        connection: payload.connection,
        projectId: payload.projectId,
      });
    } else if (
      event.type === SLACK_TEAM_UNCLAIMED_EVENT_TYPE &&
      claims.get(payload.teamId)?.projectId === payload.projectId
    ) {
      claims.delete(payload.teamId);
    }
  }
  return claims;
}

export async function lookupSlackTeamClaim(
  teamId: string,
): Promise<{ connection: string; projectId: string } | null> {
  const events = await readAllStreamEvents(null, SLACK_TEAM_DIRECTORY_STREAM_PATH);
  return foldSlackTeamDirectory(events).get(teamId) ?? null;
}
