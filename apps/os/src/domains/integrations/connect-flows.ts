// Itx-side OAuth connect flows for Slack and Google, resurrected from the
// legacy integration plumbing (pre-migration integration-api.ts, git history, +
// the pre-purge secrets domain) and re-homed onto itx:
//
//   - OAuth state:    stateless HMAC-signed token (oauth-state.ts), no D1.
//   - Slack token:    itx secret DO `/secrets/integrations/slack/bot-token`
//                     (egress-substituted; material never read back).
//   - Slack facts:    `/integrations/slack` project stream (connected/
//                     disconnected + the webhook router's events).
//   - Team routing:   deployment-wide `/integrations/slack-team-directory`
//                     stream (claimed/unclaimed events, folded per webhook).
//   - Google tokens:  AES-GCM ciphertext events on `/integrations/google`
//                     (google-tokens.ts).
//
// These functions run in itx workers (they need SECRET_ENCRYPTION_KEY and
// the DO bindings). The app worker's /api/integrations/* routes reach them
// through the itx surface (rpc-targets.ts).

import type {
  CompleteConnectResult,
  IntegrationConnectionStatus,
  IntegrationProvider,
  RouteSlackWebhookResult,
} from "../../types.ts";
import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "../secrets/crypto.ts";
import {
  createOAuthState,
  randomBase64Url,
  sha256Base64Url,
  verifyOAuthState,
} from "./oauth-state.ts";
import {
  foldSlackTeamDirectory,
  integrationStreamStub,
  lookupSlackTeamProject,
  readAllStreamEvents,
} from "./integration-streams.ts";
import { readGoogleTokenState } from "./google-tokens.ts";
import { callProjectSlackWebApi } from "./slack-api.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  GOOGLE_INTEGRATION_STREAM_PATH,
  SLACK_BOT_TOKEN_SECRET_PATH,
  SLACK_CONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
  SLACK_INTEGRATION_STREAM_PATH,
  SLACK_TEAM_CLAIMED_EVENT_TYPE,
  SLACK_TEAM_DIRECTORY_STREAM_PATH,
  SLACK_TEAM_UNCLAIMED_EVENT_TYPE,
  SLACK_WEBHOOK_RECEIVED_EVENT_TYPE,
} from "./utils.ts";
import type { AppConfig } from "~/config.ts";

function requireSlackConfig(config: AppConfig) {
  const slack = config.integrations.slack;
  if (!slack) throw new Error("Slack integration runtime config is not configured.");
  return slack;
}

function requireGoogleConfig(config: AppConfig) {
  const google = config.integrations.google;
  if (!google) throw new Error("Google integration runtime config is not configured.");
  return google;
}

function oauthRedirectUri(input: { baseUrl: string; provider: IntegrationProvider }) {
  return `${input.baseUrl.replace(/\/$/, "")}/api/integrations/${input.provider}/callback`;
}

function requestBaseUrl(input: { config: AppConfig }) {
  if (input.config.baseUrl) return input.config.baseUrl;
  throw new Error("config.baseUrl is required for OAuth flows.");
}

// ---------------------------------------------------------------------------
// OAuth start
// ---------------------------------------------------------------------------

export async function startOAuthFlow(input: {
  callbackUrl?: string;
  config: AppConfig;
  projectId: string;
  provider: IntegrationProvider;
  /** The user to bind the OAuth state to. Browser-supplied, not authority; the
   * callback's user check against the signed state is the backstop. */
  userId: string;
}): Promise<{ authorizationUrl: string }> {
  const baseUrl = requestBaseUrl(input);
  if (input.provider === "slack") {
    const slack = requireSlackConfig(input.config);
    const state = await createOAuthState(
      {
        callbackUrl: input.callbackUrl,
        projectId: input.projectId,
        provider: "slack",
        userId: input.userId,
      },
      itxEnv.SECRET_ENCRYPTION_KEY,
    );
    const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", slack.oauthClientId);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      oauthRedirectUri({ baseUrl, provider: "slack" }),
    );
    authorizationUrl.searchParams.set("scope", slack.scopes.join(","));
    authorizationUrl.searchParams.set("state", state);
    return { authorizationUrl: authorizationUrl.toString() };
  }

  const google = requireGoogleConfig(input.config);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = await createOAuthState(
    {
      callbackUrl: input.callbackUrl,
      codeVerifier,
      projectId: input.projectId,
      provider: "google",
      userId: input.userId,
    },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("client_id", google.oauthClientId);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("prompt", "consent");
  authorizationUrl.searchParams.set(
    "redirect_uri",
    oauthRedirectUri({ baseUrl, provider: "google" }),
  );
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", google.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  return { authorizationUrl: authorizationUrl.toString() };
}

// ---------------------------------------------------------------------------
// OAuth completion (called from the app worker's callback routes)
// ---------------------------------------------------------------------------

export async function completeSlackConnect(input: {
  code: string;
  config: AppConfig;
  projectId: string;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  const stateData = await verifyOAuthState(
    { provider: "slack", state: input.state },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (!stateData || stateData.projectId !== input.projectId) {
    return { callbackUrl: null, error: "slack_oauth_invalid_state", ok: false };
  }
  const callbackUrl = stateData.callbackUrl ?? null;
  if (input.userId === null || stateData.userId !== input.userId) {
    return { callbackUrl, error: "slack_oauth_user_mismatch", ok: false };
  }

  const slack = requireSlackConfig(input.config);
  const baseUrl = requestBaseUrl(input);
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    body: new URLSearchParams({
      client_id: slack.oauthClientId,
      client_secret: slack.oauthClientSecret.exposeSecret(),
      code: input.code,
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
    return { callbackUrl, error: tokenData.error ?? "slack_oauth_failed", ok: false };
  }

  const teamId = tokenData.team.id;
  const existingClaim = await lookupSlackTeamProject(teamId);
  if (existingClaim !== null && existingClaim !== input.projectId) {
    return { callbackUrl, error: "slack_team_already_claimed", ok: false };
  }

  await recordSlackConnection({
    accessToken: tokenData.access_token,
    projectId: input.projectId,
    scopes: slack.scopes,
    teamDomain: tokenData.team.domain,
    teamId,
    teamName: tokenData.team.name ?? teamId,
  });

  return { callbackUrl, ok: true };
}

/**
 * The storage half of a Slack connect, shared by the OAuth callback and by
 * admin/e2e seeding (which has a token but no OAuth code): store the bot
 * token as an egress-substituted secret, arm the webhook router subscription,
 * record the connected fact, and claim the team in the global directory.
 */
async function recordSlackConnection(input: {
  accessToken: string;
  projectId: string;
  scopes: readonly string[];
  teamDomain?: string;
  teamId: string;
  teamName: string;
}): Promise<void> {
  await itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({
      projectId: input.projectId,
      path: SLACK_BOT_TOKEN_SECRET_PATH,
    }),
  ).update({
    egress: { urls: ["https://slack.com"] },
    material: input.accessToken,
  });

  await integrationStreamStub(input.projectId, SLACK_INTEGRATION_STREAM_PATH).append(
    // Arm the webhook router processor on this stream (idempotent; also armed
    // at project create by the project processor).
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName: DurableObjectNameCodec.stringify({
        projectId: input.projectId,
        path: SLACK_INTEGRATION_STREAM_PATH,
      }),
      idempotencyKey: `slack-router-subscription:${input.projectId}`,
      processorSlug: SlackProcessorContract.slug,
      subscriberType: "project",
    }),
    {
      type: SLACK_CONNECTED_EVENT_TYPE,
      idempotencyKey: `slack:connected:${input.teamId}:${input.projectId}`,
      payload: {
        externalId: input.teamId,
        projectId: input.projectId,
        scopes: [...input.scopes],
        teamDomain: input.teamDomain,
        teamId: input.teamId,
        teamName: input.teamName,
      },
    },
  );

  await integrationStreamStub(null, SLACK_TEAM_DIRECTORY_STREAM_PATH).append({
    type: SLACK_TEAM_CLAIMED_EVENT_TYPE,
    idempotencyKey: `slack-team-claimed:${input.teamId}:${input.projectId}`,
    payload: {
      projectId: input.projectId,
      teamId: input.teamId,
      teamName: input.teamName,
    },
  });
}

export async function completeGoogleConnect(input: {
  code: string;
  config: AppConfig;
  projectId: string;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  const stateData = await verifyOAuthState(
    { provider: "google", state: input.state },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (!stateData || stateData.projectId !== input.projectId) {
    return { callbackUrl: null, error: "google_oauth_invalid_state", ok: false };
  }
  const callbackUrl = stateData.callbackUrl ?? null;
  if (input.userId === null || stateData.userId !== input.userId) {
    return { callbackUrl, error: "google_oauth_user_mismatch", ok: false };
  }
  if (!stateData.codeVerifier) {
    return { callbackUrl, error: "google_oauth_missing_verifier", ok: false };
  }

  const google = requireGoogleConfig(input.config);
  const baseUrl = requestBaseUrl(input);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: google.oauthClientId,
      client_secret: google.oauthClientSecret.exposeSecret(),
      code: input.code,
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
    return { callbackUrl, error: tokenData.error ?? "google_oauth_failed", ok: false };
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
    return { callbackUrl, error: "google_userinfo_failed", ok: false };
  }

  const scopes = tokenData.scope?.split(" ") ?? google.scopes;
  await integrationStreamStub(input.projectId, GOOGLE_INTEGRATION_STREAM_PATH).append({
    type: GOOGLE_CONNECTED_EVENT_TYPE,
    payload: {
      email: userInfo.email,
      encryptedAccessToken: await encryptSecretMaterial(
        tokenData.access_token,
        itxEnv.SECRET_ENCRYPTION_KEY,
      ),
      ...(tokenData.refresh_token
        ? {
            encryptedRefreshToken: await encryptSecretMaterial(
              tokenData.refresh_token,
              itxEnv.SECRET_ENCRYPTION_KEY,
            ),
          }
        : {}),
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : undefined,
      googleUserId: userInfo.id,
      name: userInfo.name,
      picture: userInfo.picture,
      projectId: input.projectId,
      scopes,
    },
  });

  return { callbackUrl, ok: true };
}

// ---------------------------------------------------------------------------
// Connection status + disconnect (the itx.integrations surface)
// ---------------------------------------------------------------------------

export async function getConnectionStatus(input: {
  projectId: string;
  provider: IntegrationProvider;
}): Promise<IntegrationConnectionStatus> {
  if (input.provider === "google") {
    const state = await readGoogleTokenState(input.projectId);
    return {
      connected: state.connected,
      displayName: state.email ?? state.name ?? null,
      externalId: state.googleUserId ?? null,
      metadata: {
        email: state.email,
        expiresAt: state.expiresAt,
        name: state.name,
        picture: state.picture,
        refreshTokenStored: state.encryptedRefreshToken !== undefined,
        scopes: state.scopes,
      },
    };
  }

  // The slack router processor's reduced state is the connection projection.
  const project = itxEnv.PROJECT.getByName(
    DurableObjectNameCodec.stringify({
      projectId: input.projectId,
      path: SLACK_INTEGRATION_STREAM_PATH,
    }),
  );
  const snapshot = await (await project.slackProcessor).snapshot();
  const connection = snapshot.state.connection;
  return {
    connected: connection.status === "connected",
    displayName: connection.teamName ?? null,
    externalId: connection.externalId ?? null,
    metadata: {
      teamId: connection.teamId,
      teamName: connection.teamName,
    },
  };
}

export async function disconnectProvider(input: {
  config: AppConfig;
  projectId: string;
  provider: IntegrationProvider;
}): Promise<{ success: true }> {
  if (input.provider === "slack") {
    const status = await getConnectionStatus(input);
    // Revoke the token Slack-side (auth.revoke revokes the calling token, so
    // the secret-substituted egress path works without reading material).
    await callProjectSlackWebApi({
      body: {},
      method: "auth.revoke",
      projectId: input.projectId,
    }).catch(() => null);
    // Secrets have no delete; emptying the egress allowlist makes the stored
    // material unusable.
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: input.projectId,
        path: SLACK_BOT_TOKEN_SECRET_PATH,
      }),
    )
      .update({ egress: { urls: [] } })
      .catch(() => null);
    await integrationStreamStub(input.projectId, SLACK_INTEGRATION_STREAM_PATH).append({
      type: SLACK_DISCONNECTED_EVENT_TYPE,
      payload: {
        externalId: status.externalId ?? undefined,
        projectId: input.projectId,
        teamId: (status.metadata.teamId as string | undefined) ?? undefined,
        teamName: (status.metadata.teamName as string | undefined) ?? undefined,
      },
    });
    const teamId = status.metadata.teamId as string | undefined;
    if (teamId) {
      await integrationStreamStub(null, SLACK_TEAM_DIRECTORY_STREAM_PATH).append({
        type: SLACK_TEAM_UNCLAIMED_EVENT_TYPE,
        payload: { projectId: input.projectId, teamId },
      });
    }
    return { success: true };
  }

  const state = await readGoogleTokenState(input.projectId);
  if (state.connected && state.encryptedAccessToken !== undefined) {
    const token = await decryptSecretMaterial(
      state.encryptedAccessToken,
      itxEnv.SECRET_ENCRYPTION_KEY,
    ).catch(() => null);
    if (token !== null) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }).catch(() => null);
    }
  }
  await integrationStreamStub(input.projectId, GOOGLE_INTEGRATION_STREAM_PATH).append({
    type: GOOGLE_DISCONNECTED_EVENT_TYPE,
    payload: { projectId: input.projectId },
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Webhook routing (deployment-wide, admin/internal only)
// ---------------------------------------------------------------------------

/**
 * Routes one validly-signed Slack webhook body to the project that claimed its
 * team, by appending it to that project's `/integrations/slack` stream. The
 * unclaimed case reports `ignored` so the webhook route can ACK-and-drop —
 * see handleVerifiedSlackWebhook in integration-api.ts for why that MUST be a
 * 200.
 */
export async function routeSlackWebhook(input: {
  headers: { slackEventId: string | null; slackRequestTimestamp: string | null };
  payload: Record<string, unknown>;
  teamId: string;
}): Promise<RouteSlackWebhookResult> {
  const events = await readAllStreamEvents(null, SLACK_TEAM_DIRECTORY_STREAM_PATH);
  const projectId = foldSlackTeamDirectory(events).get(input.teamId);
  if (projectId === undefined) return { ignored: "team-not-claimed", ok: true };

  await integrationStreamStub(projectId, SLACK_INTEGRATION_STREAM_PATH).append({
    type: SLACK_WEBHOOK_RECEIVED_EVENT_TYPE,
    idempotencyKey:
      typeof input.payload.event_id === "string"
        ? `slack-webhook:${input.payload.event_id}`
        : typeof input.payload.trigger_id === "string"
          ? `slack-webhook:${input.payload.trigger_id}`
          : `slack-webhook:${crypto.randomUUID()}`,
    payload: {
      headers: input.headers,
      slackTeamId: input.teamId,
      body: input.payload,
    },
  });
  return { ok: true, projectId };
}
