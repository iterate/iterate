// The Slack webhook HTTP lanes (/api/integrations/slack/webhook and
// .../interactivity-webhook), served by the API WORKER — not the app worker.
// The api worker carries the full engine binding set, so a validly-signed
// event routes straight into the claiming project's stream via
// routeSlackWebhook() — no capnweb round trip through the deployment's own
// /api surface (which is how this code worked when it lived app-side).
import { routeSlackWebhook } from "./connect-flows.ts";
import { verifySlackSignature } from "./integration-api.ts";
import type { AppConfig } from "~/config.ts";

/**
 * Serve one request if it is a Slack webhook lane; null means "not mine".
 */
export async function handleSlackWebhookApiRequest(input: {
  config: AppConfig;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/integrations/slack/webhook") {
    return await handleVerifiedSlackWebhook({ ...input, parsePayload: parseSlackJsonPayload });
  }
  if (url.pathname === "/api/integrations/slack/interactivity-webhook") {
    return await handleVerifiedSlackWebhook({
      ...input,
      parsePayload: parseSlackInteractivityPayload,
    });
  }
  return null;
}

/**
 * Handle one inbound Slack webhook (Events API callback or interactivity POST).
 *
 * ## The cardinal rule: ACK every *validly-signed* event with an HTTP 2xx
 *
 * Our Slack app is **distributed** — a single app (one signing secret, one
 * Request URL) installed across many workspaces. Slack does not give each
 * workspace its own endpoint: every install POSTs the same
 * `/api/integrations/slack/webhook` URL. But only a handful of those workspaces
 * are ever "claimed" by an OS project, so the *majority* of events we receive
 * are for teams we have nowhere to route to.
 *
 * Slack treats ANY non-2xx response as a failed delivery, and it auto-disables
 * an app's event subscriptions — for ALL workspaces, not just the failing one —
 * when failures exceed 95% of attempts over a rolling 60-minute window:
 *
 *   https://docs.slack.dev/apis/events-api/  ("Failure limits")
 *   > When your application enters any combination of these failure conditions
 *   > for more than 95% of delivery attempts within 60 minutes, your
 *   > application's event subscriptions will be temporarily disabled.
 *   > ...We receive any other response than an HTTP 200-series response.
 *
 * So if we answer "team not claimed" with a 404 (as this handler once did), a
 * distributed app whose traffic is mostly unclaimed workspaces sits permanently
 * above the 95% failure line. Slack disables delivery for the entire app and
 * even the *claimed* workspaces go silent. This is exactly the prd outage of
 * 2026-06-15: ~99% of webhook responses were 404s and the one claimed workspace
 * stopped receiving events. See `incident_slack_webhook_404_autodisable`.
 *
 * The fix is to ACK-and-drop: any request that is validly signed but that we
 * can't route (unparseable body, no team id, unclaimed team) returns a **200**.
 * The body of a 200 is ignored by Slack, so we include an `ignored` reason
 * purely for our own debuggability. Dropping at 200 keeps our success rate at
 * ~100% no matter how many unclaimed workspaces hammer the endpoint.
 *
 * Why a 200 rather than a non-2xx carrying `X-Slack-No-Retry: 1`? That header
 * only suppresses *retries of a single event*; the original delivery still
 * counts as a failure against the 95% auto-disable rule. Only a 2xx both
 * suppresses the retry AND counts as a success. So 200 is strictly the right
 * tool here — the no-retry header would not have prevented this outage.
 *
 * The ONE non-2xx we deliberately keep is the signature-verification failure
 * (401). A request that fails signature verification is not proven to come from
 * Slack at all — ACKing it 200 would let any unauthenticated caller flood us
 * with "successful" writes, and the signature check is our entire trust
 * boundary. The trade-off: if our OWN signing secret is ever misconfigured,
 * *every* genuine Slack event 401s and Slack disables the app — but that is a
 * loud, correct failure mode for "we can no longer authenticate Slack at all,"
 * not the silent self-inflicted outage that unclaimed-team 404s caused.
 */
async function handleVerifiedSlackWebhook(input: {
  config: AppConfig;
  parsePayload(body: string): Record<string, unknown> | null;
  request: Request;
}): Promise<Response> {
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
  // Trust boundary — the only response we let stay non-2xx. See the doc comment
  // above for why an unauthenticated request must NOT be ACKed with a 200.
  if (!valid) return Response.json({ error: "Invalid Slack signature." }, { status: 401 });

  // From here down the request is provably from Slack (signature verified), so
  // every "we can't use this" branch must ACK with a 200 and drop, never a 4xx.
  const payload = input.parsePayload(body);
  if (!payload) {
    // Signed but unparseable. Should be ~never; a non-2xx here would feed the
    // auto-disable counter, so we still ACK and just note the reason.
    return Response.json({ ok: true, ignored: "unparseable-payload" });
  }
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  const teamId = readSlackTeamId(payload);
  if (!teamId) {
    // Signed Slack event with no team id we can route on (e.g. some app-level
    // events). Nothing to do, but it MUST be a 200 — see the doc comment.
    return Response.json({ ok: true, ignored: "no-team-id" });
  }

  const result = await routeSlackWebhook({
    headers: {
      slackEventId: input.request.headers.get("x-slack-event-id"),
      slackRequestTimestamp: input.request.headers.get("x-slack-request-timestamp"),
    },
    payload,
    teamId,
  });

  if ("ignored" in result) {
    // The common case for a distributed app: a workspace where our app is
    // installed but which no OS project has claimed. This is the branch whose
    // old 404 caused the 2026-06-15 outage — it is the *expected steady state*
    // (most of our inbound traffic), so it MUST ACK with a 200 and drop.
    //
    // Intentionally not logged per-event: at hundreds of unclaimed events/hour
    // this is normal background traffic, not an error. To measure the
    // claimed/unclaimed split, group Slack webhook requests by response in
    // Workers observability rather than scraping logs.
    return Response.json({ ok: true, ignored: result.ignored });
  }

  return Response.json({ ok: true });
}

function readSlackTeamId(payload: Record<string, unknown>) {
  const teamId = payload.team_id;
  if (typeof teamId === "string") return teamId;
  const team = payload.team;
  if (team && typeof team === "object" && !Array.isArray(team)) {
    const nestedTeamId = (team as Record<string, unknown>).id;
    if (typeof nestedTeamId === "string") return nestedTeamId;
  }
  const event = payload.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const eventTeamId = (event as Record<string, unknown>).team;
    if (typeof eventTeamId === "string") return eventTeamId;
  }
  return null;
}

function parseSlackJsonPayload(body: string) {
  try {
    const payload = JSON.parse(body) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseSlackInteractivityPayload(body: string) {
  const payload = new URLSearchParams(body).get("payload");
  if (!payload) return null;
  return parseSlackJsonPayload(payload);
}
