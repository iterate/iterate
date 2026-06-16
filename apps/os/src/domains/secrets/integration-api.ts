import { env } from "cloudflare:workers";
import { getInitializedStreamStub } from "~/domains/streams/stream-runtime.ts";
import type { Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";
import {
  appendIntegrationEvent,
  GOOGLE_CONNECTED_EVENT_TYPE,
  SLACK_CONNECTED_EVENT_TYPE,
  SLACK_INTEGRATION_STREAM_PATH,
} from "~/domains/secrets/integration-streams.ts";
import {
  consumeOAuthState,
  getProjectConnectionByWebhookIdentifier,
  projectSecretId,
  upsertProjectConnection,
  upsertProjectSecret,
} from "~/domains/secrets/secrets-store.ts";
import {
  getSlackIntegrationDurableObjectName,
  getSlackIntegrationStub,
} from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
import {
  oauthRedirectUri,
  providerSecretKey,
  requestBaseUrl,
  requireGoogleConfig,
  requireSlackConfig,
} from "~/domains/secrets/oauth.ts";

export async function handleIntegrationApiRequest(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/integrations/slack/callback") {
    return await handleSlackCallback(input);
  }
  if (url.pathname === "/api/integrations/google/callback") {
    return await handleGoogleCallback(input);
  }
  if (url.pathname === "/api/integrations/slack/webhook") {
    return await handleSlackWebhook(input);
  }
  if (url.pathname === "/api/integrations/slack/interactivity-webhook") {
    return await handleSlackInteractivityWebhook(input);
  }
  return null;
}

async function handleSlackCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });

  const stateData = await consumeOAuthState(input.context.db, { provider: "slack", state });
  if (!stateData)
    return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
  if (error) return redirectWithError(stateData.callbackUrl, "slack_oauth_denied");
  if (!code) return redirectWithError(stateData.callbackUrl, "slack_oauth_missing_code");
  const userMismatchResponse = requireCallbackUser(input.auth, stateData.userId);
  if (userMismatchResponse) return userMismatchResponse;

  const config = requireSlackConfig(input.context.config);
  const baseUrl = requestBaseUrl({ config: input.context.config, request: input.request });
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    body: new URLSearchParams({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret.exposeSecret(),
      code,
      redirect_uri: oauthRedirectUri({ baseUrl, provider: "slack" }),
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    ok?: boolean;
    team?: { id?: string; name?: string; domain?: string };
  };

  if (
    !tokenResponse.ok ||
    tokenData.ok === false ||
    !tokenData.access_token ||
    !tokenData.team?.id
  ) {
    return redirectWithError(stateData.callbackUrl, tokenData.error ?? "slack_oauth_failed");
  }

  const existingClaim = await getProjectConnectionByWebhookIdentifier(input.context.db, {
    provider: "slack",
    webhookProviderIdentifier: tokenData.team.id,
  });
  if (existingClaim && existingClaim.projectId !== stateData.projectId) {
    return redirectWithError(stateData.callbackUrl, "slack_team_already_claimed");
  }

  const connection = await upsertProjectConnection(input.context.db, {
    externalId: tokenData.team.id,
    projectId: stateData.projectId,
    provider: "slack",
    providerData: {
      teamId: tokenData.team.id,
      teamName: tokenData.team.name ?? tokenData.team.id,
      teamDomain: tokenData.team.domain,
    },
    scopes: config.scopes.join(","),
    webhookProviderIdentifier: tokenData.team.id,
  });
  await upsertProjectSecret(input.context.db, {
    id: projectSecretId({ typeIdPrefix: input.context.config.typeIdPrefix }),
    key: providerSecretKey("slack"),
    material: tokenData.access_token,
    metadata: {
      provider: "slack",
      scopes: config.scopes,
      teamId: tokenData.team.id,
      teamName: tokenData.team.name ?? tokenData.team.id,
    },
    projectId: stateData.projectId,
  });
  await appendIntegrationEvent(input.context, {
    projectId: stateData.projectId,
    provider: "slack",
    event: {
      type: SLACK_CONNECTED_EVENT_TYPE,
      idempotencyKey: `slack:connected:${connection.id}:${connection.updatedAt}`,
      payload: {
        connectionId: connection.id,
        externalId: connection.externalId,
        projectId: stateData.projectId,
        scopes: config.scopes,
        teamDomain: tokenData.team.domain,
        teamId: tokenData.team.id,
        teamName: tokenData.team.name ?? tokenData.team.id,
        webhookProviderIdentifier: connection.webhookProviderIdentifier,
      },
    },
  });

  return Response.redirect(stateData.callbackUrl ?? "/", 302);
}

async function handleGoogleCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });

  const stateData = await consumeOAuthState(input.context.db, { provider: "google", state });
  if (!stateData)
    return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
  if (error) return redirectWithError(stateData.callbackUrl, "google_oauth_denied");
  if (!code) return redirectWithError(stateData.callbackUrl, "google_oauth_missing_code");
  if (!stateData.codeVerifier) {
    return redirectWithError(stateData.callbackUrl, "google_oauth_missing_verifier");
  }
  const userMismatchResponse = requireCallbackUser(input.auth, stateData.userId);
  if (userMismatchResponse) return userMismatchResponse;

  const config = requireGoogleConfig(input.context.config);
  const baseUrl = requestBaseUrl({ config: input.context.config, request: input.request });
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret.exposeSecret(),
      code,
      code_verifier: stateData.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri({ baseUrl, provider: "google" }),
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!tokenResponse.ok || !tokenData.access_token) {
    return redirectWithError(stateData.callbackUrl, tokenData.error ?? "google_oauth_failed");
  }

  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = (await userInfoResponse.json()) as {
    email?: string;
    id?: string;
    name?: string;
    picture?: string;
  };
  if (!userInfoResponse.ok || !userInfo.id) {
    return redirectWithError(stateData.callbackUrl, "google_userinfo_failed");
  }

  const connection = await upsertProjectConnection(input.context.db, {
    externalId: userInfo.id,
    projectId: stateData.projectId,
    provider: "google",
    providerData: {
      email: userInfo.email,
      googleUserId: userInfo.id,
      name: userInfo.name,
      picture: userInfo.picture,
    },
    scopes: tokenData.scope ?? config.scopes.join(" "),
  });
  await upsertProjectSecret(input.context.db, {
    id: projectSecretId({ typeIdPrefix: input.context.config.typeIdPrefix }),
    key: providerSecretKey("google"),
    material: tokenData.access_token,
    metadata: {
      email: userInfo.email,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : undefined,
      googleUserId: userInfo.id,
      provider: "google",
      refreshToken: tokenData.refresh_token,
      scopes: tokenData.scope?.split(" ") ?? config.scopes,
    },
    projectId: stateData.projectId,
  });
  const scopes = tokenData.scope?.split(" ") ?? config.scopes;
  await appendIntegrationEvent(input.context, {
    projectId: stateData.projectId,
    provider: "google",
    event: {
      type: GOOGLE_CONNECTED_EVENT_TYPE,
      idempotencyKey: `google-integration:connected:${connection.id}:${connection.updatedAt}`,
      payload: {
        connectionId: connection.id,
        email: userInfo.email,
        externalId: connection.externalId,
        googleUserId: userInfo.id,
        name: userInfo.name,
        picture: userInfo.picture,
        projectId: stateData.projectId,
        scopes,
      },
    },
  });

  return Response.redirect(stateData.callbackUrl ?? "/", 302);
}

async function handleSlackWebhook(input: { context: RequestContext; request: Request }) {
  return await handleVerifiedSlackWebhook({
    ...input,
    parsePayload: parseSlackJsonPayload,
  });
}

async function handleSlackInteractivityWebhook(input: {
  context: RequestContext;
  request: Request;
}) {
  return await handleVerifiedSlackWebhook({
    ...input,
    parsePayload: parseSlackInteractivityPayload,
  });
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
 * So if we answer "team not claimed" with a 404 (as this handler used to), a
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
}) {
  const config = requireSlackConfig(input.context.config);
  const body = await input.request.text();
  const valid = await verifySlackSignature({
    body,
    signature: input.request.headers.get("x-slack-signature"),
    signingSecret: config.webhookSigningSecret.exposeSecret(),
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

  const connection = await getProjectConnectionByWebhookIdentifier(input.context.db, {
    provider: "slack",
    webhookProviderIdentifier: teamId,
  });
  if (!connection) {
    // The common case for a distributed app: a workspace where our app is
    // installed but which no OS project has claimed. This is the branch whose
    // old 404 caused the 2026-06-15 outage — it is the *expected steady state*
    // (most of our inbound traffic), so it MUST ACK with a 200 and drop.
    //
    // Intentionally not logged per-event: at hundreds of unclaimed events/hour
    // this is normal background traffic, not an error. To measure the
    // claimed/unclaimed split, group Slack webhook requests by response in
    // Workers observability rather than scraping logs.
    return Response.json({ ok: true, ignored: "team-not-claimed" });
  }
  const slackIntegrationName = getSlackIntegrationDurableObjectName(connection.projectId);
  const slackIntegration = getSlackIntegrationStub(connection.projectId) as unknown as {
    ensureReady(): Promise<unknown>;
    initialize(input: { name: string }): Promise<unknown>;
  };

  const stream = await getInitializedStreamStub({
    durableObjectNamespace: env.STREAM as never,
    namespace: connection.projectId,
    path: SLACK_INTEGRATION_STREAM_PATH,
  });
  await stream.append({
    type: "events.iterate.com/slack/webhook-received",
    idempotencyKey:
      typeof payload.event_id === "string"
        ? `slack-webhook:${payload.event_id}`
        : typeof payload.trigger_id === "string"
          ? `slack-webhook:${payload.trigger_id}`
          : `slack-webhook:${crypto.randomUUID()}`,
    payload: {
      headers: {
        slackEventId: input.request.headers.get("x-slack-event-id"),
        slackRequestTimestamp: input.request.headers.get("x-slack-request-timestamp"),
      },
      slackTeamId: teamId,
      body: payload,
    },
  });
  // Only the durable append gates the 200: Slack retries webhooks that take
  // longer than ~3s, and awaiting the integration DO's initialize here used to
  // serialize a cold DO chain ahead of the ack (observed at 8s in prd, with
  // the retry queueing behind the same cold gate). Initialization is
  // order-independent: an existing integration already has its
  // subscription-configured event on the stream, and a brand-new one picks the
  // webhook up via replay once the background initialize lands it.
  input.context.waitUntil?.(
    (async () => {
      await slackIntegration.initialize({ name: slackIntegrationName });
      await slackIntegration.ensureReady();
    })().catch((error) => {
      console.error("[slack-integration-webhook] background catch-up failed", error);
    }),
  );

  return Response.json({ ok: true });
}

function redirectWithError(callbackUrl: string | null, error: string) {
  if (!callbackUrl) return Response.redirect(`/?error=${encodeURIComponent(error)}`, 302);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return Response.redirect(url.toString(), 302);
}

function requireCallbackUser(auth: Principal | null | undefined, expectedUserId: string) {
  if (auth?.type !== "user" || auth.userId !== expectedUserId) {
    return new Response("OAuth callback user mismatch.", { status: 403 });
  }
  return null;
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

async function verifySlackSignature(input: {
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
