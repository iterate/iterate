// itx-side OAuth connect flows for Slack and Google, resurrected from the
// legacy integration plumbing (pre-migration integration-api.ts, git history, +
// the pre-purge secrets domain) and re-homed onto itx:
//
// Every connection is NAMED: a project can hold several Slack workspaces and
// several Google accounts, each addressed by a sanitized connection name.
//
//   - OAuth state:    stateless HMAC-signed token (oauth-state.ts), no D1.
//   - Slack token:    itx secret DO `/secrets/integrations/slack/{connection}/bot-token`
//                     (egress-substituted; material never read back).
//   - Slack facts:    `/integrations/slack/{connection}` project stream
//                     (connected/disconnected + the webhook router's events).
//   - Team routing:   deployment-wide `/integrations/slack-team-directory`
//                     stream (claimed/unclaimed events, folded per webhook).
//   - Google tokens:  AES-GCM ciphertext events on
//                     `/integrations/google/{connection}` (google-tokens.ts).
//
// These functions run with the itx bindings (they need SECRET_ENCRYPTION_KEY and
// the DO bindings). The dashboard's /api/integrations/* routes reach them
// through the itx surface (rpc-targets.ts).

import type {
  CompleteConnectResult,
  IntegrationConnectionStatus,
  BuiltinIntegrationSlug,
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
  integrationStreamStub,
  lookupSlackTeamClaim,
  streamEventsNewestFirst,
} from "./integration-streams.ts";
import { readGoogleTokenState } from "./google-tokens.ts";
import { callProjectSlackWebApi } from "./slack-api.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";
import {
  GITHUB_CONNECTED_EVENT_TYPE,
  GITHUB_DISCONNECTED_EVENT_TYPE,
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  SLACK_CONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
  SLACK_TEAM_CLAIMED_EVENT_TYPE,
  SLACK_TEAM_DIRECTORY_STREAM_PATH,
  SLACK_TEAM_UNCLAIMED_EVENT_TYPE,
  SLACK_WEBHOOK_RECEIVED_EVENT_TYPE,
  integrationCoordinatesFromStreamPath,
  readRecord,
  readString,
  integrationConnectionStreamPath,
  sanitizeConnectionName,
  githubTokenSecretPath,
  slackBotTokenSecretPath,
} from "./utils.ts";
import type { AppConfig } from "~/config.ts";

function requireSlackConfig(config: AppConfig) {
  const slack = config.integrations.slack;
  if (!slack) throw new Error("Slack integration runtime config is not configured.");
  return slack;
}

function requireGithubConfig(config: AppConfig) {
  const github = config.integrations.github;
  if (!github) throw new Error("GitHub integration runtime config is not configured.");
  return github;
}

function requireGoogleConfig(config: AppConfig) {
  const google = config.integrations.google;
  if (!google) throw new Error("Google integration runtime config is not configured.");
  return google;
}

function oauthRedirectUri(input: { baseUrl: string; provider: BuiltinIntegrationSlug }) {
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
  provider: BuiltinIntegrationSlug;
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

  if (input.provider === "github") {
    const github = requireGithubConfig(input.config);
    const state = await createOAuthState(
      {
        callbackUrl: input.callbackUrl,
        projectId: input.projectId,
        provider: "github",
        userId: input.userId,
      },
      itxEnv.SECRET_ENCRYPTION_KEY,
    );
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", github.oauthClientId);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      oauthRedirectUri({ baseUrl, provider: "github" }),
    );
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
// OAuth completion (called from the dashboard's callback routes)
// ---------------------------------------------------------------------------

/**
 * The one connect-completion verb: the app worker's OAuth callback route calls
 * this provider-blind. Each provider contributes only its exchange half; the
 * storage half is the shared {@link recordConnection}.
 */
export async function completeConnect(input: {
  code: string;
  config: AppConfig;
  projectId: string;
  provider: BuiltinIntegrationSlug;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  switch (input.provider) {
    case "slack":
      return await completeSlackConnect(input);
    case "google":
      return await completeGoogleConnect(input);
    case "github":
      return await completeGithubConnect(input);
  }
}

/**
 * The provider-invariant storage half of a connect, shared by every provider's
 * exchange half and by admin/e2e seeding (which has a token but no OAuth
 * code). Material travels by argument into Secret DOs — never onto journals.
 */
async function recordConnection(input: {
  connection: string;
  projectId: string;
  slug: string;
  /** Credential material, each written to its own Secret DO with an egress
   * allowlist. Empty for providers whose tokens live on the journal
   * (google's refresh flow needs raw material back — see google-tokens.ts). */
  secrets: readonly { egressUrls: readonly string[]; material: string; path: string }[];
  /** The connected fact, appended to /integrations/{slug}/{connection}. */
  connectedEvent: { idempotencyKey?: string; payload: Record<string, unknown>; type: string };
  /** Arm a webhook-router processor on the connection stream (providers that
   * route inbound events). Connect time is THE arming point — connection
   * streams are born here, not at project create. */
  processorSubscription?: { idempotencyKey: string; processorSlug: string };
  /** Claim this connection's routing key in a deployment-wide directory
   * stream (providers with first-party webhook ingress). */
  directoryClaim?: {
    event: { idempotencyKey?: string; payload: Record<string, unknown>; type: string };
    streamPath: string;
  };
}): Promise<void> {
  const streamPath = integrationConnectionStreamPath(input.slug, input.connection);
  for (const secret of input.secrets) {
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({ projectId: input.projectId, path: secret.path }),
    ).update({
      egress: { urls: [...secret.egressUrls] },
      material: secret.material,
    });
  }
  await integrationStreamStub(input.projectId, streamPath).append(
    ...(input.processorSubscription
      ? [
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: input.projectId,
              path: streamPath,
            }),
            idempotencyKey: input.processorSubscription.idempotencyKey,
            processorSlug: input.processorSubscription.processorSlug,
            subscriberType: "project" as const,
          }),
        ]
      : []),
    input.connectedEvent,
  );
  if (input.directoryClaim) {
    await integrationStreamStub(null, input.directoryClaim.streamPath).append(
      input.directoryClaim.event,
    );
  }
}

async function completeSlackConnect(input: {
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
  const existingClaim = await lookupSlackTeamClaim(teamId);
  if (existingClaim !== null && existingClaim.projectId !== input.projectId) {
    return { callbackUrl, error: "slack_team_already_claimed", ok: false };
  }

  // Reconnects reuse the claiming connection's name; fresh connects derive it
  // from the workspace domain (or the team id when the domain sanitizes away).
  const connection =
    existingClaim?.connection ??
    (sanitizeConnectionName(tokenData.team.domain ?? teamId) ||
      `team-${sanitizeConnectionName(teamId)}`);

  await recordSlackConnection({
    accessToken: tokenData.access_token,
    connection,
    projectId: input.projectId,
    scopes: slack.scopes,
    teamDomain: tokenData.team.domain,
    teamId,
    teamName: tokenData.team.name ?? teamId,
  });

  return { callbackUrl, ok: true };
}

/** Slack's storage half, expressed through the shared {@link recordConnection}. */
async function recordSlackConnection(input: {
  accessToken: string;
  connection: string;
  projectId: string;
  scopes: readonly string[];
  teamDomain?: string;
  teamId: string;
  teamName: string;
}): Promise<void> {
  await recordConnection({
    connection: input.connection,
    projectId: input.projectId,
    slug: "slack",
    secrets: [
      {
        egressUrls: ["https://slack.com"],
        material: input.accessToken,
        path: slackBotTokenSecretPath(input.connection),
      },
    ],
    // Deliberately NO idempotency keys on the connected/claim facts: a
    // disconnect->reconnect cycle must append fresh facts, and a key of
    // (team, project) would dedupe the reconnect into silence (connected
    // never re-folds, the team never re-claims). The OAuth code exchange is
    // single-use, so the callback cannot double-fire these appends.
    connectedEvent: {
      type: SLACK_CONNECTED_EVENT_TYPE,
      payload: {
        connection: input.connection,
        externalId: input.teamId,
        projectId: input.projectId,
        scopes: [...input.scopes],
        teamDomain: input.teamDomain,
        teamId: input.teamId,
        teamName: input.teamName,
      },
    },
    processorSubscription: {
      idempotencyKey: `slack-router-subscription:${input.projectId}:${input.connection}`,
      processorSlug: SlackProcessorContract.slug,
    },
    directoryClaim: {
      streamPath: SLACK_TEAM_DIRECTORY_STREAM_PATH,
      event: {
        type: SLACK_TEAM_CLAIMED_EVENT_TYPE,
        payload: {
          connection: input.connection,
          projectId: input.projectId,
          teamId: input.teamId,
          teamName: input.teamName,
        },
      },
    },
  });
}

async function completeGithubConnect(input: {
  code: string;
  config: AppConfig;
  projectId: string;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  const stateData = await verifyOAuthState(
    { provider: "github", state: input.state },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (!stateData || stateData.projectId !== input.projectId) {
    return { callbackUrl: null, error: "github_oauth_invalid_state", ok: false };
  }
  const callbackUrl = stateData.callbackUrl ?? null;
  if (input.userId === null || stateData.userId !== input.userId) {
    return { callbackUrl, error: "github_oauth_user_mismatch", ok: false };
  }

  const github = requireGithubConfig(input.config);
  const baseUrl = requestBaseUrl(input);
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    body: new URLSearchParams({
      client_id: github.oauthClientId,
      client_secret: github.oauthClientSecret.exposeSecret(),
      code: input.code,
      redirect_uri: oauthRedirectUri({ baseUrl, provider: "github" }),
    }),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    expires_in?: number;
  };
  if (!tokenResponse.ok || !tokenData.access_token) {
    return { callbackUrl, error: tokenData.error ?? "github_oauth_failed", ok: false };
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenData.access_token}`,
      "user-agent": "iterate-os",
    },
  });
  const user = (await userResponse.json()) as { id?: number; login?: string };
  if (!userResponse.ok || user.id === undefined) {
    return { callbackUrl, error: "github_user_lookup_failed", ok: false };
  }

  // The GitHub login names the connection; the opaque numeric id is the
  // fallback when the login sanitizes away.
  const connection =
    sanitizeConnectionName(user.login ?? "") || `github-${sanitizeConnectionName(String(user.id))}`;
  await recordConnection({
    connection,
    projectId: input.projectId,
    slug: "github",
    secrets: [
      {
        // api.github.com for gh/REST; github.com + uploads/objects hosts so
        // git-over-https and release/LFS traffic substitute too.
        egressUrls: [
          "https://api.github.com",
          "https://github.com",
          "https://uploads.github.com",
          "https://objects.githubusercontent.com",
        ],
        material: tokenData.access_token,
        path: githubTokenSecretPath(connection),
      },
    ],
    connectedEvent: {
      type: GITHUB_CONNECTED_EVENT_TYPE,
      payload: {
        connection,
        externalId: String(user.id),
        login: user.login,
        projectId: input.projectId,
        // GitHub Apps can be configured to issue expiring user tokens; when
        // expires_in is present the token dies after ~8h and refresh is the
        // (deferred) derived-secrets follow-up — recorded so status can say so.
        ...(tokenData.expires_in
          ? { expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString() }
          : {}),
      },
    },
  });

  return { callbackUrl, ok: true };
}

async function completeGoogleConnect(input: {
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

  // The Gmail local part names the connection; opaque Google ids are the
  // fallback when the email is missing or sanitizes away.
  const connection =
    sanitizeConnectionName(userInfo.email?.split("@")[0] ?? "") ||
    `google-${sanitizeConnectionName(userInfo.id)}`;
  const scopes = tokenData.scope?.split(" ") ?? google.scopes;
  await recordConnection({
    connection,
    projectId: input.projectId,
    slug: "google",
    secrets: [],
    connectedEvent: {
      type: GOOGLE_CONNECTED_EVENT_TYPE,
      payload: {
        connection,
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
    },
  });

  return { callbackUrl, ok: true };
}

// ---------------------------------------------------------------------------
// Connection status + disconnect (the itx.integrations surface)
// ---------------------------------------------------------------------------

export async function getConnectionStatus(input: {
  connection: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
}): Promise<IntegrationConnectionStatus> {
  if (input.provider === "google") {
    const state = await readGoogleTokenState(input.projectId, input.connection);
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

  if (input.provider === "github") {
    const path = integrationConnectionStreamPath("github", input.connection);
    for await (const event of streamEventsNewestFirst(input.projectId, path)) {
      if (
        event.type !== GITHUB_CONNECTED_EVENT_TYPE &&
        event.type !== GITHUB_DISCONNECTED_EVENT_TYPE
      ) {
        continue;
      }
      const payload = readRecord(event.payload) ?? {};
      return {
        connected: event.type === GITHUB_CONNECTED_EVENT_TYPE,
        displayName: readString(payload.login) ?? null,
        externalId: readString(payload.externalId) ?? null,
        metadata: {
          expiresAt: readString(payload.expiresAt),
          login: readString(payload.login),
        },
      };
    }
    return { connected: false, displayName: null, externalId: null, metadata: {} };
  }

  // Slack status is the same machine as google's: a newest-first fold over
  // the connection journal that stops at the first lifecycle fact. Reading
  // the journal directly (not a processor snapshot) gives read-your-writes
  // right after connect and skips the project-DO cold-start chain.
  const path = integrationConnectionStreamPath("slack", input.connection);
  for await (const event of streamEventsNewestFirst(input.projectId, path)) {
    if (event.type !== SLACK_CONNECTED_EVENT_TYPE && event.type !== SLACK_DISCONNECTED_EVENT_TYPE) {
      continue;
    }
    const payload = readRecord(event.payload) ?? {};
    return {
      connected: event.type === SLACK_CONNECTED_EVENT_TYPE,
      displayName: readString(payload.teamName) ?? null,
      externalId: readString(payload.externalId) ?? null,
      metadata: {
        teamId: readString(payload.teamId),
        teamName: readString(payload.teamName),
      },
    };
  }
  return { connected: false, displayName: null, externalId: null, metadata: {} };
}

export async function disconnectProvider(input: {
  config: AppConfig;
  connection: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
}): Promise<{ success: true }> {
  if (input.provider === "slack") {
    const status = await getConnectionStatus(input);
    // Revoke the token Slack-side (auth.revoke revokes the calling token, so
    // the secret-substituted egress path works without reading material).
    await callProjectSlackWebApi({
      body: {},
      connection: input.connection,
      method: "auth.revoke",
      projectId: input.projectId,
    }).catch(() => null);
    // Secrets have no delete; emptying the egress allowlist makes the stored
    // material unusable.
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: input.projectId,
        path: slackBotTokenSecretPath(input.connection),
      }),
    )
      .update({ egress: { urls: [] } })
      .catch(() => null);
    await integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("slack", input.connection),
    ).append({
      type: SLACK_DISCONNECTED_EVENT_TYPE,
      payload: {
        connection: input.connection,
        externalId: status.externalId ?? undefined,
        projectId: input.projectId,
        teamId: (status.metadata.teamId as string | undefined) ?? undefined,
        teamName: (status.metadata.teamName as string | undefined) ?? undefined,
      },
    });
    const teamId = status.metadata.teamId as string | undefined;
    if (teamId) {
      // The unclaim names the connection: the fold only clears a claim when
      // BOTH match, so disconnecting a stale connection of a team that has
      // since been re-claimed under a new name cannot tear down the live one.
      await integrationStreamStub(null, SLACK_TEAM_DIRECTORY_STREAM_PATH).append({
        type: SLACK_TEAM_UNCLAIMED_EVENT_TYPE,
        payload: { connection: input.connection, projectId: input.projectId, teamId },
      });
    }
    return { success: true };
  }

  if (input.provider === "github") {
    // No provider-side revocation: it would require reading the raw token
    // back (Basic-auth DELETE /applications/{client_id}/token), and
    // disconnect never touches material. Emptying the egress allowlist makes
    // the stored token unusable for API calls and sandbox reveals alike.
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: input.projectId,
        path: githubTokenSecretPath(input.connection),
      }),
    )
      .update({ egress: { urls: [] } })
      .catch(() => null);
    await integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("github", input.connection),
    ).append({
      type: GITHUB_DISCONNECTED_EVENT_TYPE,
      payload: { connection: input.connection, projectId: input.projectId },
    });
    return { success: true };
  }

  const state = await readGoogleTokenState(input.projectId, input.connection);
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
  await integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("google", input.connection),
  ).append({
    type: GOOGLE_DISCONNECTED_EVENT_TYPE,
    payload: { projectId: input.projectId },
  });
  return { success: true };
}

/**
 * Lists the project's named integration connections by reading the project
 * root processor's stream catalogue: every `/integrations/<slug>/<connection>`
 * stream the project has created is one connection entry — the path shape is
 * the truth, deliberately not filtered to built-in slugs, so a provided
 * integration that journals its facts there (e.g. webhooks landing on
 * /integrations/github/main) enumerates like everything else.
 */
export async function listIntegrationConnections(
  projectId: string,
): Promise<{ connection: string; integration: string; path: string }[]> {
  const project = itxEnv.PROJECT.getByName(
    DurableObjectNameCodec.stringify({ projectId, path: "/" }),
  );
  const snapshot = await (await project.processor).snapshot();
  const entries: { connection: string; integration: string; path: string }[] = [];
  for (const stream of snapshot.state.streams) {
    const coordinates = integrationCoordinatesFromStreamPath(stream.path);
    if (coordinates === null) continue;
    entries.push({
      connection: coordinates.connection,
      integration: coordinates.slug,
      path: stream.path,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Webhook routing (deployment-wide, admin/internal only)
// ---------------------------------------------------------------------------

/**
 * Routes one validly-signed Slack webhook body to the project + connection
 * that claimed its team, by appending it to that connection's
 * `/integrations/slack/{connection}` stream. The unclaimed case reports
 * `ignored` so the webhook route can ACK-and-drop — see
 * handleVerifiedSlackWebhook in integration-api.ts for why that MUST be a
 * 200.
 */
export async function routeSlackWebhook(input: {
  headers: { slackEventId: string | null; slackRequestTimestamp: string | null };
  payload: Record<string, unknown>;
  teamId: string;
}): Promise<RouteSlackWebhookResult> {
  const claim = await lookupSlackTeamClaim(input.teamId);
  if (claim === null) return { ignored: "team-not-claimed", ok: true };

  await integrationStreamStub(
    claim.projectId,
    integrationConnectionStreamPath("slack", claim.connection),
  ).append({
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
  return { connection: claim.connection, ok: true, projectId: claim.projectId };
}
