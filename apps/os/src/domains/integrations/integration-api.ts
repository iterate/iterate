// The /api/integrations/* HTTP surface, mounted under the Start catch-all
// route (src/routes/api.$.ts) in the app worker.
//
// Resurrected from the pre-migration integration-api.ts (git history). The app
// worker has no itx bindings, so every itx effect goes through a
// one-shot pipelined capnweb HTTP batch against this deployment's own
// /api/itx surface using the admin API secret — the same request-scoped
// pattern the inbound MCP exec_js tool uses.

// oxlint-disable-next-line iterate/no-capnweb-http-batch -- integration callbacks/webhooks are one-shot request-scoped calls: a single pipelined batch (authenticate -> route/complete) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import type { UnauthenticatedItx } from "../../types.ts";
import { parseOAuthStateUnverified } from "./oauth-state.ts";
import type { Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";

export async function handleIntegrationApiRequest(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/integrations/slack/callback") {
    return await handleOAuthCallback({ ...input, provider: "slack" });
  }
  if (url.pathname === "/api/integrations/google/callback") {
    return await handleOAuthCallback({ ...input, provider: "google" });
  }
  if (url.pathname === "/api/integrations/slack/webhook") {
    return await handleVerifiedSlackWebhook({
      ...input,
      parsePayload: parseSlackJsonPayload,
    });
  }
  if (url.pathname === "/api/integrations/slack/interactivity-webhook") {
    return await handleVerifiedSlackWebhook({
      ...input,
      parsePayload: parseSlackInteractivityPayload,
    });
  }
  return null;
}

/** One-shot pipelined capnweb batch against this deployment's own itx surface. */
function engineBatchSession(context: RequestContext) {
  const baseUrl = (context.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is not configured");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per integration request; no socket lifecycle to manage.
  return newHttpBatchRpcSession<UnauthenticatedItx>(
    new Request(`${baseUrl}/api/itx`, { method: "POST" }),
  );
}

function requireAdminSecret(context: RequestContext): string {
  const secret = context.config.adminApiSecret?.exposeSecret();
  if (!secret) throw new Error("Admin API secret is not configured.");
  return secret;
}

async function handleOAuthCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  provider: "google" | "slack";
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });
  const unverified = parseOAuthStateUnverified(state);
  if (!unverified || unverified.provider !== input.provider) {
    return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
  }
  const callbackUrl = unverified.callbackUrl ?? null;
  if (error) return redirectWithError(callbackUrl, `${input.provider}_oauth_denied`);
  if (!code) return redirectWithError(callbackUrl, `${input.provider}_oauth_missing_code`);

  // The signed-state userId binding: the user completing the flow must be the
  // user who started it. The state signature itself is verified itx-side;
  // here we only need who the browser session is.
  const userId = input.auth?.type === "user" ? input.auth.userId : null;
  if (userId === null) return new Response("OAuth callback user mismatch.", { status: 403 });

  const session = engineBatchSession(input.context);
  const root = session.authenticate({
    type: "admin-secret",
    secret: requireAdminSecret(input.context),
  });
  const project = root.projects.get(unverified.projectId);
  const result =
    input.provider === "slack"
      ? await project.integrations.completeSlackConnect({ code, state, userId })
      : await project.integrations.completeGoogleConnect({ code, state, userId });

  if (!result.ok) {
    if (result.error.endsWith("_user_mismatch")) {
      return new Response("OAuth callback user mismatch.", { status: 403 });
    }
    if (result.error.endsWith("_invalid_state")) {
      return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
    }
    return redirectWithError(result.callbackUrl ?? callbackUrl, result.error);
  }
  return redirectResponse(result.callbackUrl ?? callbackUrl ?? "/");
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
  context: RequestContext;
  parsePayload(body: string): Record<string, unknown> | null;
  request: Request;
}): Promise<Response> {
  const slack = input.context.config.integrations.slack;
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

  const session = engineBatchSession(input.context);
  const root = session.authenticate({
    type: "admin-secret",
    secret: requireAdminSecret(input.context),
  });
  const result = await root.integrations.routeSlackWebhook({
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

function redirectWithError(callbackUrl: string | null, error: string) {
  if (!callbackUrl) return redirectResponse(`/?error=${encodeURIComponent(error)}`);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return redirectResponse(url.toString());
}

// Response.redirect rejects relative URLs, and the app's own origin is not
// knowable here without config.baseUrl — a plain 302 Location header is.
function redirectResponse(location: string) {
  return new Response(null, { headers: { location }, status: 302 });
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

export async function verifySlackSignature(input: {
  body: string;
  signature: string | null;
  signingSecret: string;
  timestamp: string | null;
}) {
  if (!input.signature || !input.timestamp) return false;
  const timestampNumber = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 60 * 5) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.body}`),
  );
  const expected = `v0=${hex(new Uint8Array(signature))}`;
  return constantTimeEqual(expected, input.signature);
}

/** Encode HMAC bytes in the lowercase hex format Slack expects in v0 signatures. */
function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
