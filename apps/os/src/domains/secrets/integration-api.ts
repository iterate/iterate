import { getInitializedStreamStub } from "@iterate-com/shared/streams/helpers";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE, type Event } from "@iterate-com/shared/streams/types";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import type { ClerkAuth } from "~/context.ts";
import type { AppContext } from "~/context.ts";
import {
  appendIntegrationEvent,
  GOOGLE_CONNECTED_EVENT_TYPE,
  SLACK_CONNECTED_EVENT_TYPE,
  SLACK_INTEGRATION_STREAM_PATH,
} from "~/domains/secrets/integration-streams.ts";
import {
  consumeOAuthState,
  getProjectConnectionByWebhookIdentifier,
  getProjectSecret,
  projectSecretId,
  upsertProjectConnection,
  upsertProjectSecret,
} from "~/domains/secrets/secrets-store.ts";
import { getSlackIntegrationDurableObjectName } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import {
  oauthRedirectUri,
  providerSecretKey,
  requestBaseUrl,
  requireGoogleConfig,
  requireSlackConfig,
} from "~/domains/secrets/oauth.ts";

export async function handleIntegrationApiRequest(input: {
  auth: ClerkAuth;
  context: AppContext;
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
  auth: ClerkAuth;
  context: AppContext;
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
    id: projectSecretId({ typeIdPrefix: input.context.config.typeIdPrefix.exposeSecret() }),
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
  auth: ClerkAuth;
  context: AppContext;
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
    id: projectSecretId({ typeIdPrefix: input.context.config.typeIdPrefix.exposeSecret() }),
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

async function handleSlackWebhook(input: { context: AppContext; request: Request }) {
  return await handleVerifiedSlackWebhook({
    ...input,
    parsePayload: parseSlackJsonPayload,
  });
}

async function handleSlackInteractivityWebhook(input: { context: AppContext; request: Request }) {
  return await handleVerifiedSlackWebhook({
    ...input,
    parsePayload: parseSlackInteractivityPayload,
  });
}

async function handleVerifiedSlackWebhook(input: {
  context: AppContext;
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
  if (!valid) return Response.json({ error: "Invalid Slack signature." }, { status: 401 });

  const payload = input.parsePayload(body);
  if (!payload)
    return Response.json({ error: "Slack webhook payload is invalid." }, { status: 400 });
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  const teamId = readSlackTeamId(payload);
  if (!teamId)
    return Response.json({ error: "Slack webhook is missing team_id." }, { status: 400 });

  const connection = await getProjectConnectionByWebhookIdentifier(input.context.db, {
    provider: "slack",
    webhookProviderIdentifier: teamId,
  });
  if (!connection) {
    return Response.json({ error: "Slack team is not claimed by a project." }, { status: 404 });
  }
  if (!input.context.stream) {
    return Response.json({ error: "STREAM binding is not available." }, { status: 500 });
  }
  if (!input.context.slackIntegration) {
    return Response.json({ error: "SLACK_INTEGRATION binding is not available." }, { status: 500 });
  }

  const reactionPromise = addIngressSlackEyesReaction({
    context: input.context,
    payload,
    projectId: connection.projectId,
  }).catch((error) => {
    console.error("[slack-integration] ingress eyes reaction crashed", { error });
  });
  input.context.waitUntil?.(reactionPromise);
  void reactionPromise;

  const stream = await getInitializedStreamStub({
    durableObjectNamespace: input.context.stream as never,
    namespace: connection.projectId,
    path: SLACK_INTEGRATION_STREAM_PATH,
  });

  const slackIntegrationName = getSlackIntegrationDurableObjectName(connection.projectId);
  const appendedEvents = await stream.appendBatch([
    {
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `slack-subscription:${connection.projectId}`,
      payload: {
        slug: `slack:${connection.projectId}`,
        type: "callable",
        eventTypes: [...SlackProcessorContract.consumes],
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "SLACK_INTEGRATION",
            durableObject: {
              name: slackIntegrationName,
            },
          },
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    },
    {
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
    },
  ]);
  const webhookEvent = appendedEvents.find(
    (event) => event.type === "events.iterate.com/slack/webhook-received",
  );
  if (webhookEvent != null) {
    const slackIntegrationWakePromise = wakeSlackIntegrationFastPath({
      context: input.context,
      event: webhookEvent,
      projectId: connection.projectId,
    }).catch((error) => {
      console.error("[slack-integration] fast-path wake failed", { error });
    });
    input.context.waitUntil?.(slackIntegrationWakePromise);
    void slackIntegrationWakePromise;
  }

  return Response.json({ ok: true });
}

async function wakeSlackIntegrationFastPath(input: {
  context: AppContext;
  event: Event;
  projectId: string;
}) {
  if (!input.context.slackIntegration) return;

  const slackIntegrationName = getSlackIntegrationDurableObjectName(input.projectId);
  const stub = input.context.slackIntegration.getByName(slackIntegrationName);
  await stub.afterAppend({ event: input.event });
}

async function addIngressSlackEyesReaction(input: {
  context: AppContext;
  payload: unknown;
  projectId: string;
}) {
  const target = slackEyesReactionTarget(input.payload);
  if (target == null) return;

  const token = await readSlackBotToken(input);
  if (!token) return;

  try {
    await callSlackWebApi({
      method: "reactions.add",
      token,
      body: {
        channel: target.channel,
        name: "eyes",
        timestamp: target.messageTs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already_reacted")) return;
    console.error("[slack-integration] ingress eyes reaction failed", {
      channel: target.channel,
      error,
      messageTs: target.messageTs,
    });
  }
}

async function readSlackBotToken(input: { context: AppContext; projectId: string }) {
  const secret = await getProjectSecret(input.context.db, {
    key: "slack.access_token",
    projectId: input.projectId,
  });
  if (secret) return secret.material;

  return input.context.config.slackBotToken?.exposeSecret() ?? "";
}

function slackEyesReactionTarget(payload: unknown): { channel: string; messageTs: string } | null {
  const body = readRecord(payload);
  if (body?.type !== "event_callback") return null;

  const event = readRecord(body.event);
  if (event == null) return null;
  const eventType = readString(event.type);
  if (eventType === "reaction_added" || eventType === "reaction_removed") return null;

  const botUserId = readSlackAuthorizedBotUserId(body);
  if (botUserId != null && readString(event.user) === botUserId) return null;

  const channel = readString(event.channel);
  const message = readRecord(event.message);
  const messageTs = readString(event.ts) ?? readString(message?.ts);
  if (channel == null || messageTs == null) return null;

  return { channel, messageTs };
}

function readSlackAuthorizedBotUserId(body: Record<string, unknown>) {
  const authorizations = body.authorizations;
  if (!Array.isArray(authorizations)) return null;
  for (const authorization of authorizations) {
    const record = readRecord(authorization);
    if (record?.is_bot === true) {
      const userId = readString(record.user_id);
      if (userId != null) return userId;
    }
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redirectWithError(callbackUrl: string | null, error: string) {
  if (!callbackUrl) return Response.redirect(`/?error=${encodeURIComponent(error)}`, 302);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return Response.redirect(url.toString(), 302);
}

function requireCallbackUser(auth: ClerkAuth, expectedUserId: string) {
  if (!auth.isAuthenticated || auth.userId !== expectedUserId) {
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
