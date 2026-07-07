// Slack's inbound-webhook fetch: an imperative handler that does whatever Slack
// needs — verify the signature, answer the url_verification handshake, parse
// both the Events API (JSON) and interactivity (form-encoded) lanes, and route
// a validly-signed event to the claiming connection's stream. It is NOT built
// on a generic "verify → extract → route" pipeline: integrations differ too
// much for that (design note — integrations are imperative fetch functions over
// shared primitives, not a webhook framework). The one shared primitive it uses
// is routeIntegrationWebhook (append to the (slug, externalId) claim's stream).
//
// ## The cardinal rule: ACK every *validly-signed* event with an HTTP 2xx
//
// Our Slack app is DISTRIBUTED — one app (one signing secret, one Request URL)
// installed across many workspaces, most of which no OS project has claimed.
// Slack auto-disables an app's event deliveries (for ALL workspaces) when
// failures cross 95% over 60 min, and treats any non-2xx as a failure. So any
// request that is validly signed but unroutable (unparseable, no team id,
// unclaimed team) returns a 200 with an `ignored` reason — dropping at 200 keeps
// our success rate ~100%. See incident_slack_webhook_404_autodisable. The ONE
// non-2xx we keep is signature-verification failure (401): the signature is our
// entire trust boundary, and ACKing an unauthenticated request would let anyone
// flood us with writes.

import { routeIntegrationWebhook } from "./integration-streams.ts";
import { verifySlackSignature } from "./slack-signature.ts";
import { parseJsonRecord, readString, SLACK_WEBHOOK_RECEIVED_EVENT_TYPE } from "./utils.ts";
import type { AppConfig } from "~/config.ts";

const WEBHOOK_PATH = "/api/integrations/slack/webhook";
const INTERACTIVITY_PATH = "/api/integrations/slack/interactivity-webhook";

/** Serve one Slack webhook request, or null if the path isn't Slack's. */
export async function fetchSlackWebhook(input: {
  config: AppConfig;
  request: Request;
}): Promise<Response | null> {
  const pathname = new URL(input.request.url).pathname;
  const interactivity = pathname === INTERACTIVITY_PATH;
  if (pathname !== WEBHOOK_PATH && !interactivity) return null;

  const slack = input.config.integrations.slack;
  if (!slack) {
    return Response.json({ error: "Slack integration is not configured." }, { status: 503 });
  }

  const body = await input.request.text();
  const valid = await verifySlackSignature({
    body,
    signature: input.request.headers.get("x-slack-signature"),
    signingSecret: slack.webhookSigningSecret.exposeSecret(),
    timestamp: input.request.headers.get("x-slack-request-timestamp"),
  });
  // Trust boundary — the only non-2xx (see the cardinal rule).
  if (!valid) return Response.json({ error: "Invalid Slack signature." }, { status: 401 });

  // Signed → every "can't use this" branch ACKs 200 and drops.
  const payload = interactivity ? parseInteractivityPayload(body) : parseJsonRecord(body);
  if (!payload) return Response.json({ ignored: "unparseable-payload", ok: true });
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  const teamId = readSlackTeamId(payload);
  if (!teamId) return Response.json({ ignored: "no-team-id", ok: true });

  const result = await routeIntegrationWebhook({
    event: {
      idempotencyKey: `slack-webhook:${readString(payload.event_id) ?? readString(payload.trigger_id) ?? crypto.randomUUID()}`,
      // The exact shape the Slack agent router reads (D1 — untouched).
      payload: {
        body: payload,
        headers: {
          slackEventId: input.request.headers.get("x-slack-event-id"),
          slackRequestTimestamp: input.request.headers.get("x-slack-request-timestamp"),
        },
        slackTeamId: teamId,
      },
      type: SLACK_WEBHOOK_RECEIVED_EVENT_TYPE,
    },
    externalId: teamId,
    slug: "slack",
  });
  if ("ignored" in result) return Response.json({ ignored: result.ignored, ok: true });
  return Response.json({ ok: true });
}

function parseInteractivityPayload(body: string): Record<string, unknown> | null {
  const payload = new URLSearchParams(body).get("payload");
  return payload ? parseJsonRecord(payload) : null;
}

function readSlackTeamId(payload: Record<string, unknown>): string | null {
  if (typeof payload.team_id === "string") return payload.team_id;
  const team = payload.team;
  if (team && typeof team === "object" && !Array.isArray(team)) {
    const id = (team as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  const event = payload.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const teamId = (event as Record<string, unknown>).team;
    if (typeof teamId === "string") return teamId;
  }
  return null;
}
