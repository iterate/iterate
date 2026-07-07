// itx-side connect/disconnect flows for the built-in integrations (Slack +
// Google OAuth, GitHub App installation). Each provider contributes only its
// exchange half; the storage half is the shared recordConnection.
//
// Every connection is NAMED: a project can hold several Slack workspaces /
// Google accounts / GitHub installations, each at a sanitized connection name.
//
//   - Connect state:  stateless HMAC-signed token (oauth-state.ts), no D1.
//   - Credentials:    a Secret DO per connection at
//                     `/secrets/integrations/<slug>/<connection>` — a bot token
//                     (slack), `{ accessToken, refreshToken }` + the shared
//                     oauth-refresh-token strategy (google), or an empty
//                     material + the github-app-installation mint strategy
//                     (github). Material is never read back: refresh runs in
//                     the Secret DO's own trusted code.
//   - Facts:          `/integrations/<slug>/<connection>` project stream
//                     (connected/disconnected + inbound webhook events).
//   - Routing:        the deployment-wide `(slug, externalId)` directory
//                     (integration-streams.ts) — claimed at connect, folded by
//                     the webhook door to route inbound events.
//
// These run with the itx bindings (SECRET_ENCRYPTION_KEY + the DO bindings).
// The dashboard's /api/integrations/* routes reach them via itx (rpc-targets.ts).

import type {
  CompleteConnectResult,
  IntegrationConnectionStatus,
  BuiltinIntegrationSlug,
  SecretRefresh,
} from "../../types.ts";
import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import {
  createOAuthState,
  randomBase64Url,
  sha256Base64Url,
  verifyOAuthState,
  type OAuthStateData,
} from "./oauth-state.ts";
import {
  appendConnectionDirectoryEvent,
  integrationStreamStub,
  lookupConnectionClaim,
  streamEventsNewestFirst,
} from "./integration-streams.ts";
import { callProjectSlackWebApi } from "./slack-api.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";
import {
  GITHUB_CONNECTED_EVENT_TYPE,
  GITHUB_CONNECTION_EGRESS_URLS,
  GITHUB_DISCONNECTED_EVENT_TYPE,
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_CONNECTION_EGRESS_URLS,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  GOOGLE_OAUTH_TOKEN_URL,
  SLACK_CONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
  githubConnectionSecretPath,
  googleConnectionSecretPath,
  integrationCoordinatesFromStreamPath,
  readRecord,
  readString,
  integrationConnectionStreamPath,
  sanitizeConnectionName,
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
    // GitHub App installation (D5), not OAuth-user: the user installs the App on
    // their org/repos and GitHub redirects back with an `installation_id` (not a
    // code). Our signed `state` round-trips the project + user so the callback
    // can bind the installation to them.
    if (!github.appSlug) {
      throw new Error(
        "GitHub App is not configured (integrations.github.appSlug); cannot start an installation.",
      );
    }
    const state = await createOAuthState(
      {
        callbackUrl: input.callbackUrl,
        projectId: input.projectId,
        provider: "github",
        userId: input.userId,
      },
      itxEnv.SECRET_ENCRYPTION_KEY,
    );
    const authorizationUrl = new URL(`https://github.com/apps/${github.appSlug}/installations/new`);
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
  /** OAuth authorization code (slack/google). */
  code?: string;
  config: AppConfig;
  /** GitHub App installation id — github's callback carries this, not a code. */
  installationId?: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  switch (input.provider) {
    case "slack":
      if (input.code === undefined) {
        return { callbackUrl: null, error: "slack_oauth_missing_code", ok: false };
      }
      return await completeSlackConnect({ ...input, code: input.code });
    case "google":
      if (input.code === undefined) {
        return { callbackUrl: null, error: "google_oauth_missing_code", ok: false };
      }
      return await completeGoogleConnect({ ...input, code: input.code });
    case "github":
      if (input.installationId === undefined) {
        return { callbackUrl: null, error: "github_missing_installation_id", ok: false };
      }
      return await completeGithubConnect({ ...input, installationId: input.installationId });
  }
}

/**
 * The shared front door of every provider's connect completion: verify the
 * HMAC-signed state, bind it to the calling project, and check the caller is
 * the user who started the flow. Error codes keep the provider-specific
 * strings: `${errorPrefix}_invalid_state` / `${errorPrefix}_user_mismatch`.
 */
async function gateConnectState(input: {
  errorPrefix: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
  state: string;
  userId: string | null;
}): Promise<
  | { callbackUrl: string | null; ok: true; stateData: OAuthStateData }
  | { ok: false; result: CompleteConnectResult }
> {
  const stateData = await verifyOAuthState(
    { provider: input.provider, state: input.state },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (!stateData || stateData.projectId !== input.projectId) {
    return {
      ok: false,
      result: { callbackUrl: null, error: `${input.errorPrefix}_invalid_state`, ok: false },
    };
  }
  const callbackUrl = stateData.callbackUrl ?? null;
  if (input.userId === null || stateData.userId !== input.userId) {
    return {
      ok: false,
      result: { callbackUrl, error: `${input.errorPrefix}_user_mismatch`, ok: false },
    };
  }
  return { callbackUrl, ok: true, stateData };
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
   * allowlist. `material` is any serializable value (a bare token string for
   * Slack; `{ accessToken, refreshToken }` for Google). An optional `refresh`
   * configures the secret's named refresh strategy (run by the Secret DO's own
   * trusted code) — no provider stores tokens on the journal. */
  secrets: readonly {
    egressUrls: readonly string[];
    material: unknown;
    path: string;
    refresh?: SecretRefresh;
  }[];
  /** The connected fact, appended to /integrations/{slug}/{connection}. */
  connectedEvent: { idempotencyKey?: string; payload: Record<string, unknown>; type: string };
  /** Arm a webhook-router processor on the connection stream (providers that
   * route inbound events). Connect time is THE arming point — connection
   * streams are born here, not at project create. */
  processorSubscription?: { idempotencyKey: string; processorSlug: string };
  /** Claim this connection's external id in the deployment-wide directory
   * (providers with first-party webhook ingress). The generic door folds it to
   * route inbound events (D4). */
  directoryClaim?: { externalId: string };
}): Promise<void> {
  const streamPath = integrationConnectionStreamPath(input.slug, input.connection);
  for (const secret of input.secrets) {
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({ projectId: input.projectId, path: secret.path }),
    ).update({
      egress: { urls: [...secret.egressUrls] },
      material: secret.material,
      ...(secret.refresh ? { refresh: secret.refresh } : {}),
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
    await appendConnectionDirectoryEvent({
      claimed: true,
      connection: input.connection,
      externalId: input.directoryClaim.externalId,
      projectId: input.projectId,
      slug: input.slug,
    });
  }
}

async function completeSlackConnect(input: {
  code: string;
  config: AppConfig;
  projectId: string;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  const gate = await gateConnectState({ ...input, errorPrefix: "slack_oauth", provider: "slack" });
  if (!gate.ok) return gate.result;
  const { callbackUrl } = gate;

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
  const existingClaim = await lookupConnectionClaim("slack", teamId);
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
    directoryClaim: { externalId: input.teamId },
  });
}

async function completeGithubConnect(input: {
  config: AppConfig;
  installationId: string;
  projectId: string;
  state: string;
  userId: string | null;
}): Promise<CompleteConnectResult> {
  const gate = await gateConnectState({
    ...input,
    errorPrefix: "github_oauth",
    provider: "github",
  });
  if (!gate.ok) return gate.result;
  const { callbackUrl } = gate;

  const github = requireGithubConfig(input.config);
  if (!github.appId) {
    return { callbackUrl, error: "github_app_not_configured", ok: false };
  }

  // App installation (D5), not OAuth-user: no code exchange, no user lookup. The
  // installation id is the stable handle (it names the connection AND is the
  // directory external id the webhook door routes on). It is public, so it
  // lives in the refresh strategy config, not in material: the Secret DO's
  // github-app-installation strategy mints the installation token on first use
  // (and re-mints on 401) by signing an App JWT with the first-party App key
  // resolved from deployment config — trusted DO code.
  const connection = `install-${sanitizeConnectionName(input.installationId)}`;
  await recordConnection({
    connection,
    projectId: input.projectId,
    slug: "github",
    secrets: [
      {
        egressUrls: GITHUB_CONNECTION_EGRESS_URLS,
        material: {},
        path: githubConnectionSecretPath(connection),
        refresh: {
          kind: "github-app-installation",
          apiBase: "https://api.github.com",
          appId: github.appId,
          installationId: input.installationId,
          privateKey: { platform: "integrations.github" },
        },
      },
    ],
    connectedEvent: {
      type: GITHUB_CONNECTED_EVENT_TYPE,
      payload: {
        connection,
        externalId: input.installationId,
        installationId: input.installationId,
        projectId: input.projectId,
      },
    },
    directoryClaim: { externalId: input.installationId },
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
  const gate = await gateConnectState({
    ...input,
    errorPrefix: "google_oauth",
    provider: "google",
  });
  if (!gate.ok) return gate.result;
  const { callbackUrl, stateData } = gate;
  if (!stateData.codeVerifier) {
    return { callbackUrl, error: "google_oauth_missing_verifier", ok: false };
  }

  const google = requireGoogleConfig(input.config);
  const baseUrl = requestBaseUrl(input);
  const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
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

  // The full email names the connection (domain included), so two accounts
  // that share a local part — jonas@nustom.com vs jonas@gmail.com — get
  // distinct connections instead of colliding on one journal; opaque Google
  // ids are the fallback when the email is missing or sanitizes away.
  const connection =
    sanitizeConnectionName(userInfo.email ?? "") || `google-${sanitizeConnectionName(userInfo.id)}`;
  const scopes = tokenData.scope?.split(" ") ?? google.scopes;
  // Tokens live in a connection secret (write-only), refreshed on 401 by the
  // shared oauth-refresh-token strategy in the Secret DO's own trusted code,
  // with the platform Google client credential resolved from deployment
  // config. No tokens on the journal — the connected fact carries only
  // display metadata.
  await recordConnection({
    connection,
    projectId: input.projectId,
    slug: "google",
    secrets: [
      {
        egressUrls: GOOGLE_CONNECTION_EGRESS_URLS,
        material: {
          accessToken: tokenData.access_token,
          ...(tokenData.refresh_token ? { refreshToken: tokenData.refresh_token } : {}),
        },
        path: googleConnectionSecretPath(connection),
        refresh: {
          kind: "oauth-refresh-token",
          tokenEndpoint: GOOGLE_OAUTH_TOKEN_URL,
          clientCreds: { platform: "integrations.google" },
        },
      },
    ],
    connectedEvent: {
      type: GOOGLE_CONNECTED_EVENT_TYPE,
      payload: {
        connection,
        email: userInfo.email,
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

/**
 * The most recent lifecycle fact (connected/disconnected) of one connection
 * journal, folded newest-first — the one status machine every provider shares.
 * Reading the journal directly (not a processor snapshot) gives read-your-writes
 * right after connect and skips the project-DO cold-start chain. Null when the
 * journal holds no lifecycle fact (never connected).
 */
async function latestLifecycleFact(input: {
  connectedType: string;
  connection: string;
  disconnectedType: string;
  projectId: string;
  slug: string;
}): Promise<{ connected: boolean; payload: Record<string, unknown> } | null> {
  const path = integrationConnectionStreamPath(input.slug, input.connection);
  for await (const event of streamEventsNewestFirst(input.projectId, path)) {
    if (event.type !== input.connectedType && event.type !== input.disconnectedType) continue;
    return {
      connected: event.type === input.connectedType,
      payload: readRecord(event.payload) ?? {},
    };
  }
  return null;
}

/** The "never connected" status — also google's disconnected shape (its
 * disconnected fact carries no metadata). */
function notConnectedStatus(): IntegrationConnectionStatus {
  return { connected: false, displayName: null, externalId: null, metadata: {} };
}

export async function getConnectionStatus(input: {
  connection: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
}): Promise<IntegrationConnectionStatus> {
  switch (input.provider) {
    case "slack": {
      const fact = await latestLifecycleFact({
        connectedType: SLACK_CONNECTED_EVENT_TYPE,
        connection: input.connection,
        disconnectedType: SLACK_DISCONNECTED_EVENT_TYPE,
        projectId: input.projectId,
        slug: "slack",
      });
      if (!fact) return notConnectedStatus();
      return {
        connected: fact.connected,
        displayName: readString(fact.payload.teamName) ?? null,
        externalId: readString(fact.payload.externalId) ?? null,
        metadata: {
          teamId: readString(fact.payload.teamId),
          teamName: readString(fact.payload.teamName),
        },
      };
    }
    case "github": {
      const fact = await latestLifecycleFact({
        connectedType: GITHUB_CONNECTED_EVENT_TYPE,
        connection: input.connection,
        disconnectedType: GITHUB_DISCONNECTED_EVENT_TYPE,
        projectId: input.projectId,
        slug: "github",
      });
      if (!fact) return notConnectedStatus();
      return {
        connected: fact.connected,
        displayName: readString(fact.payload.connection) ?? null,
        externalId: readString(fact.payload.externalId) ?? null,
        metadata: { installationId: readString(fact.payload.installationId) },
      };
    }
    case "google": {
      const fact = await latestLifecycleFact({
        connectedType: GOOGLE_CONNECTED_EVENT_TYPE,
        connection: input.connection,
        disconnectedType: GOOGLE_DISCONNECTED_EVENT_TYPE,
        projectId: input.projectId,
        slug: "google",
      });
      if (!fact?.connected) return notConnectedStatus();
      const email = readString(fact.payload.email);
      const name = readString(fact.payload.name);
      return {
        connected: true,
        displayName: email ?? name ?? null,
        externalId: readString(fact.payload.googleUserId) ?? null,
        metadata: {
          email,
          name,
          picture: readString(fact.payload.picture),
          scopes: Array.isArray(fact.payload.scopes)
            ? fact.payload.scopes.filter((s): s is string => typeof s === "string")
            : undefined,
        },
      };
    }
  }
}

export async function disconnectProvider(input: {
  connection: string;
  projectId: string;
  provider: BuiltinIntegrationSlug;
}): Promise<{ success: true }> {
  switch (input.provider) {
    case "slack":
      return await disconnectSlack(input);
    case "github":
      return await disconnectGithub(input);
    case "google":
      return await disconnectGoogle(input);
  }
}

/**
 * The provider-invariant storage half of a disconnect, mirroring
 * {@link recordConnection}: secrets have no delete, so emptying the egress
 * allowlist makes the stored material unusable; then the disconnected fact is
 * appended and (optionally) the external id unclaimed in the deployment-wide
 * directory. The unclaim names the connection: the fold only clears a claim
 * when BOTH match, so disconnecting a stale connection of an external id that
 * has since been re-claimed under a new name cannot tear down the live one.
 */
async function recordDisconnection(input: {
  connection: string;
  disconnectedEvent: { payload: Record<string, unknown>; type: string };
  projectId: string;
  secretPath: string;
  slug: string;
  unclaimExternalId?: string;
}): Promise<void> {
  await itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({ projectId: input.projectId, path: input.secretPath }),
  )
    .update({ egress: { urls: [] } })
    .catch(() => null);
  await integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath(input.slug, input.connection),
  ).append(input.disconnectedEvent);
  if (input.unclaimExternalId) {
    await appendConnectionDirectoryEvent({
      claimed: false,
      connection: input.connection,
      externalId: input.unclaimExternalId,
      projectId: input.projectId,
      slug: input.slug,
    });
  }
}

async function disconnectSlack(input: {
  connection: string;
  projectId: string;
}): Promise<{ success: true }> {
  const status = await getConnectionStatus({ ...input, provider: "slack" });
  // Revoke the token Slack-side (auth.revoke revokes the calling token, so
  // the secret-substituted egress path works without reading material).
  await callProjectSlackWebApi({
    body: {},
    connection: input.connection,
    method: "auth.revoke",
    projectId: input.projectId,
  }).catch(() => null);
  const teamId = status.metadata.teamId as string | undefined;
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: SLACK_DISCONNECTED_EVENT_TYPE,
      payload: {
        connection: input.connection,
        externalId: status.externalId ?? undefined,
        projectId: input.projectId,
        teamId,
        teamName: (status.metadata.teamName as string | undefined) ?? undefined,
      },
    },
    projectId: input.projectId,
    secretPath: slackBotTokenSecretPath(input.connection),
    slug: "slack",
    unclaimExternalId: teamId,
  });
  return { success: true };
}

async function disconnectGithub(input: {
  connection: string;
  projectId: string;
}): Promise<{ success: true }> {
  const status = await getConnectionStatus({ ...input, provider: "github" });
  // No provider-side revocation: installation tokens are short-lived and
  // uninstalling the App is a GitHub-side action. Emptying the egress
  // allowlist makes the connection secret unusable (the secret's fetch/mint
  // can no longer reach GitHub), and unclaiming the installation stops webhook
  // routing — disconnect never reads material.
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: GITHUB_DISCONNECTED_EVENT_TYPE,
      payload: { connection: input.connection, projectId: input.projectId },
    },
    projectId: input.projectId,
    secretPath: githubConnectionSecretPath(input.connection),
    slug: "github",
    unclaimExternalId: status.externalId ?? undefined,
  });
  return { success: true };
}

async function disconnectGoogle(input: {
  connection: string;
  projectId: string;
}): Promise<{ success: true }> {
  // No provider-side revocation — it would need the raw token back, and tokens
  // live write-only in the connection secret. Emptying the egress allowlist
  // makes the stored tokens unusable (same as GitHub/Slack). No directory
  // unclaim: google has no webhook ingress, so nothing was claimed.
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: GOOGLE_DISCONNECTED_EVENT_TYPE,
      payload: { projectId: input.projectId },
    },
    projectId: input.projectId,
    secretPath: googleConnectionSecretPath(input.connection),
    slug: "google",
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
