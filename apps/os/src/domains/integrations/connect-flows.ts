// itx-side connect/disconnect flows for the built-in integrations (Slack +
// Google OAuth, GitHub App installation, Telegram bot-token paste). Each
// provider contributes only its exchange half; the storage half is the shared
// recordConnection.
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

import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { SecretRefresh } from "../secrets/types.ts";
import type {
  CompleteConnectResult,
  IntegrationConnectionStatus,
  BuiltinIntegrationSlug,
  OAuthProviderSlug,
  RestoreIntegrationConnectionInput,
  RestoreIntegrationConnectionResult,
} from "./types.ts";
import {
  createOAuthState,
  randomBase64Url,
  sha256Base64Url,
  verifyOAuthState,
  type OAuthStateData,
} from "./oauth-state.ts";
import {
  appendConnectionDirectoryEvent,
  appendConnectionDirectoryEvents,
  integrationStreamStub,
  latestStreamEventOfTypes,
  lookupConnectionClaim,
} from "./integration-streams.ts";
import {
  buildIntegrationRouterCreatedEvent,
  buildIntegrationRouterSubscriptionConfiguredEvent,
} from "./integration-router-events.ts";
import { callProjectSlackWebApi } from "./slack-api.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";
import { callProjectTelegramBotApi, telegramApiBaseUrl } from "./telegram-api.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";
import { mintGithubInstallationToken } from "./github-app.ts";
import {
  GITHUB_CONNECTION_EGRESS_URLS,
  GOOGLE_CONNECTION_EGRESS_URLS,
  GOOGLE_OAUTH_TOKEN_URL,
  githubConnectionSecretPath,
  googleConnectionSecretPath,
  integrationCoordinatesFromStreamPath,
  readRecord,
  readString,
  integrationConnectionStreamPath,
  sanitizeConnectionName,
  slackBotTokenSecretPath,
  telegramBotTokenSecretPath,
  telegramWebhookSecretToken,
  waitroseSessionSecretPath,
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

function oauthRedirectUri(input: { baseUrl: string; provider: OAuthProviderSlug }) {
  return `${input.baseUrl.replace(/\/$/, "")}/api/integrations/${input.provider}/callback`;
}

function requestBaseUrl(input: { config: AppConfig }) {
  if (input.config.baseUrl) return input.config.baseUrl.replace(/\/$/, "");
  throw new Error("config.baseUrl is required to connect this integration.");
}

/**
 * Rebuild an already-authorized connection without replaying its old stream.
 * This is deliberately narrower than OAuth completion: only Slack bot tokens
 * and this deployment's GitHub App installations are seedable, and the caller
 * must name the immutable provider-side identity expected in the archive.
 *
 * Authorization stays at the RPC boundary (`restoreConnection` is admin-only).
 * This domain function owns credential validation, fresh secret/fact creation,
 * directory claiming, and the post-write ownership proof as one supported
 * invariant boundary.
 */
export async function restoreIntegrationConnection(
  input: RestoreIntegrationConnectionInput & {
    config: AppConfig;
    projectId: string;
  },
  dependencies: {
    fetch?: typeof fetch;
    validateGithubInstallation?: (input: {
      apiBase: string;
      appId: string;
      installationId: string;
      privateKeyPem: string;
    }) => Promise<void>;
  } = {},
): Promise<RestoreIntegrationConnectionResult> {
  if (input.provider === "slack") {
    const slack = requireSlackConfig(input.config);
    const response = await (dependencies.fetch ?? fetch)("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${input.botToken}` },
    });
    const identity = (await response.json().catch(() => null)) as {
      ok?: boolean;
      team?: string;
      team_id?: string;
      url?: string;
    } | null;
    if (!response.ok || identity?.ok !== true || !identity.team_id) {
      throw new Error(
        `Slack bot token validation failed for expected team ${input.teamId} (HTTP ${response.status}).`,
      );
    }
    if (identity.team_id !== input.teamId) {
      throw new Error(
        `Slack bot token belongs to team ${identity.team_id}, not archived team ${input.teamId}.`,
      );
    }

    const existingClaim = await lookupConnectionClaim("slack", input.teamId);
    if (existingClaim !== null && existingClaim.projectId !== input.projectId) {
      throw new Error(
        `Slack team ${input.teamId} is already claimed by project ${existingClaim.projectId}.`,
      );
    }
    const requestedConnection = input.connection
      ? requireCanonicalConnectionName(input.connection)
      : null;
    if (
      requestedConnection !== null &&
      existingClaim !== null &&
      existingClaim.connection !== requestedConnection
    ) {
      throw new Error(
        `Slack team ${input.teamId} is already connected as ${existingClaim.connection}, not archived connection ${requestedConnection}.`,
      );
    }
    const teamDomain = slackTeamDomain(identity.url);
    const connection =
      existingClaim?.connection ??
      requestedConnection ??
      (sanitizeConnectionName(teamDomain ?? input.teamId) ||
        `team-${sanitizeConnectionName(input.teamId)}`);
    const responseScopes = response.headers
      .get("x-oauth-scopes")
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    await recordSlackConnection({
      accessToken: input.botToken,
      connection,
      projectId: input.projectId,
      scopes: responseScopes?.length ? responseScopes : slack.scopes,
      teamDomain,
      teamId: input.teamId,
      teamName: identity.team ?? input.teamId,
    });

    const claim = await lookupConnectionClaim("slack", input.teamId);
    if (claim?.projectId !== input.projectId || claim.connection !== connection) {
      // Do not call Slack auth.revoke here: a racing winner may hold the same
      // bot token. Brick only this losing local generation.
      await recordDisconnection({
        connection,
        disconnectedEvent: {
          type: "events.iterate.com/slack/disconnected",
          payload: {
            connection,
            externalId: input.teamId,
            projectId: input.projectId,
            reason: "project-seed-claim-race-lost",
            teamId: input.teamId,
            teamName: identity.team ?? input.teamId,
          },
        },
        projectId: input.projectId,
        secretPath: slackBotTokenSecretPath(connection),
        slug: "slack",
      });
      throw new Error(`Slack team ${input.teamId} changed ownership while it was being restored.`);
    }
    return { connection, externalId: input.teamId, provider: "slack" };
  }

  if (input.provider === "google") {
    const google = requireGoogleConfig(input.config);
    const connection = requireCanonicalConnectionName(input.connection);
    const refreshToken = input.material.refreshToken.trim();
    if (!refreshToken) {
      throw new Error(
        `Google connection ${connection} has no refresh token; reconnect it interactively.`,
      );
    }
    const fetcher = dependencies.fetch ?? fetch;
    const tokenResponse = await fetcher(GOOGLE_OAUTH_TOKEN_URL, {
      body: new URLSearchParams({
        client_id: google.oauthClientId,
        client_secret: google.oauthClientSecret.exposeSecret(),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const tokenData = (await tokenResponse.json().catch(() => null)) as {
      access_token?: string;
      error?: string;
      scope?: string;
    } | null;
    if (!tokenResponse.ok || !tokenData?.access_token) {
      throw new Error(
        `Google refresh-token validation failed for ${connection} (HTTP ${tokenResponse.status}${
          tokenData?.error ? `, ${tokenData.error}` : ""
        }); reconnect it interactively.`,
      );
    }
    const userInfoResponse = await fetcher("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = (await userInfoResponse.json().catch(() => null)) as {
      email?: string;
      id?: string;
      name?: string;
      picture?: string;
    } | null;
    if (!userInfoResponse.ok || !userInfo?.id) {
      throw new Error(
        `Google identity validation failed for ${connection} (HTTP ${userInfoResponse.status}).`,
      );
    }
    if (userInfo.id !== input.googleUserId) {
      throw new Error(
        `Google credential belongs to user ${userInfo.id}, not archived user ${input.googleUserId}.`,
      );
    }
    const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? google.scopes;
    await recordConnection({
      connection,
      projectId: input.projectId,
      slug: "google",
      secrets: [
        {
          egressUrls: GOOGLE_CONNECTION_EGRESS_URLS,
          material: {
            accessToken: tokenData.access_token,
            refreshToken,
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
        type: "events.iterate.com/google/connected",
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
    const status = await getConnectionStatus({
      connection,
      projectId: input.projectId,
      provider: "google",
    });
    if (!status.connected || status.externalId !== input.googleUserId) {
      throw new Error(`Google connection ${connection} failed its post-write identity proof.`);
    }
    return { connection, externalId: input.googleUserId, provider: "google" };
  }

  const github = requireGithubConfig(input.config);
  if (!github.appId || !github.privateKey) {
    throw new Error("GitHub App id and private key are required to restore an installation.");
  }
  const validateGithubInstallation =
    dependencies.validateGithubInstallation ??
    (async (installation) => {
      await mintGithubInstallationToken(installation);
    });
  await validateGithubInstallation({
    apiBase: "https://api.github.com",
    appId: github.appId,
    installationId: input.installationId,
    privateKeyPem: github.privateKey.exposeSecret(),
  });

  const requestedConnection = input.connection
    ? requireCanonicalConnectionName(input.connection)
    : null;
  const existingClaim = await lookupConnectionClaim("github", input.installationId);
  if (existingClaim !== null && existingClaim.projectId !== input.projectId) {
    throw new Error(
      `GitHub installation ${input.installationId} is already claimed by project ${existingClaim.projectId}.`,
    );
  }
  if (
    requestedConnection !== null &&
    existingClaim !== null &&
    existingClaim.connection !== requestedConnection
  ) {
    throw new Error(
      `GitHub installation ${input.installationId} is already connected as ${existingClaim.connection}, not archived connection ${requestedConnection}.`,
    );
  }
  if (
    existingClaim?.projectId === input.projectId &&
    (await restoreOwnedGithubConnection({
      connection: existingClaim.connection,
      githubAppId: github.appId,
      installationId: input.installationId,
      projectId: input.projectId,
    }))
  ) {
    return {
      connection: existingClaim.connection,
      externalId: input.installationId,
      provider: "github",
    };
  }

  const connection = requestedConnection ?? newGithubConnectionName(input.installationId);
  await recordGithubConnection({
    connection,
    directoryClaim: { externalId: input.installationId },
    githubAppId: github.appId,
    installationId: input.installationId,
    projectId: input.projectId,
  });
  const claim = await lookupConnectionClaim("github", input.installationId);
  if (claim?.projectId !== input.projectId || claim.connection !== connection) {
    await recordDisconnection({
      connection,
      disconnectedEvent: {
        type: "events.iterate.com/github/disconnected",
        payload: {
          connection,
          projectId: input.projectId,
          reason: "project-seed-claim-race-lost",
        },
      },
      projectId: input.projectId,
      secretPath: githubConnectionSecretPath(connection),
      slug: "github",
    });
    throw new Error(
      `GitHub installation ${input.installationId} changed ownership while it was being restored.`,
    );
  }
  return { connection, externalId: input.installationId, provider: "github" };
}

function requireCanonicalConnectionName(connection: string): string {
  const canonical = sanitizeConnectionName(connection);
  if (!canonical || canonical !== connection) {
    throw new Error(
      `Integration connection ${JSON.stringify(connection)} is not canonical; use ${JSON.stringify(canonical)}.`,
    );
  }
  return canonical;
}

function slackTeamDomain(url: string | undefined): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.endsWith(".slack.com") ? hostname.slice(0, -".slack.com".length) : undefined;
}

// ---------------------------------------------------------------------------
// OAuth start
// ---------------------------------------------------------------------------

export async function startOAuthFlow(input: {
  callbackUrl?: string;
  config: AppConfig;
  projectId: string;
  provider: OAuthProviderSlug;
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
  /** OAuth authorization code (Slack/Google, or GitHub's proof callback). */
  code?: string;
  config: AppConfig;
  /** Untrusted GitHub setup-URL installation id, verified through user OAuth. */
  installationId?: string;
  projectId: string;
  provider: OAuthProviderSlug;
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
      return await completeGithubConnect(input);
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
  provider: OAuthProviderSlug;
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
  processorSubscription?: {
    processorSlug: string;
  };
  /** Claim this connection's external id in the deployment-wide directory
   * (providers with first-party webhook ingress). The generic door folds it to
   * route inbound events (D4). `unclaimFirst` names a claim being MOVED from
   * (telegram's steal): its unclaim commits in the SAME directory append as
   * the new claim, so live inbound traffic never observes an unclaimed window
   * (the door would ACK-and-drop, and Telegram never retries an ACK). */
  directoryClaim?: {
    externalId: string;
    unclaimFirst?: { connection: string; projectId: string };
  };
}): Promise<void> {
  const streamPath = integrationConnectionStreamPath(input.slug, input.connection);
  for (const secret of input.secrets) {
    const secretStub = itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({ projectId: input.projectId, path: secret.path }),
    );
    const secretInput = {
      egress: { urls: [...secret.egressUrls] },
      material: secret.material,
      ...(secret.refresh ? { refresh: secret.refresh } : {}),
    };
    if ((await secretStub.describe()).created) await secretStub.update(secretInput);
    else await secretStub.create(secretInput);
  }
  await integrationStreamStub(input.projectId, streamPath).append(
    ...(input.processorSubscription
      ? [
          buildIntegrationRouterCreatedEvent({
            connection: input.connection,
            slug: input.slug,
          }),
          buildIntegrationRouterSubscriptionConfiguredEvent({
            connection: input.connection,
            projectId: input.projectId,
            processorSlug: input.processorSubscription.processorSlug,
            slug: input.slug,
          }),
        ]
      : []),
    input.connectedEvent,
  );
  if (input.directoryClaim) {
    await appendConnectionDirectoryEvents([
      ...(input.directoryClaim.unclaimFirst
        ? [
            {
              claimed: false,
              connection: input.directoryClaim.unclaimFirst.connection,
              externalId: input.directoryClaim.externalId,
              projectId: input.directoryClaim.unclaimFirst.projectId,
              slug: input.slug,
            },
          ]
        : []),
      {
        claimed: true,
        connection: input.connection,
        externalId: input.directoryClaim.externalId,
        projectId: input.projectId,
        slug: input.slug,
      },
    ]);
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
        // files.slack.com serves shared-file downloads (url_private); the Web
        // API itself lives on slack.com.
        egressUrls: ["https://slack.com", "https://files.slack.com"],
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
      type: "events.iterate.com/slack/connected",
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
      processorSlug: SlackProcessorContract.slug,
    },
    directoryClaim: { externalId: input.teamId },
  });
}

async function completeGithubConnect(input: {
  code?: string;
  config: AppConfig;
  installationId?: string;
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
  const { callbackUrl, stateData } = gate;

  const github = requireGithubConfig(input.config);
  if (!github.appId) {
    return { callbackUrl, error: "github_app_not_configured", ok: false };
  }

  // GitHub warns that setup-URL installation_id values are spoofable. Treat
  // the first callback only as a prompt to start user OAuth. The signed second
  // state carries that tentative id; the user token must enumerate it before
  // we persist a claim or create a platform-key refresh strategy.
  if (stateData.githubInstallationId === undefined) {
    if (input.installationId === undefined) {
      return { callbackUrl, error: "github_missing_installation_id", ok: false };
    }
    const codeVerifier = randomBase64Url(32);
    const state = await createOAuthState(
      {
        callbackUrl: stateData.callbackUrl,
        codeVerifier,
        githubInstallationId: input.installationId,
        projectId: input.projectId,
        provider: "github",
        userId: stateData.userId,
      },
      itxEnv.SECRET_ENCRYPTION_KEY,
    );
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", github.oauthClientId);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      oauthRedirectUri({ baseUrl: requestBaseUrl(input), provider: "github" }),
    );
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    // completeConnect's existing success shape names the browser's next
    // destination. The second callback restores the product callbackUrl from
    // the newly signed state above.
    return { callbackUrl: authorizationUrl.toString(), ok: true };
  }

  if (input.code === undefined) {
    return { callbackUrl, error: "github_oauth_missing_code", ok: false };
  }
  if (
    input.installationId !== undefined &&
    input.installationId !== stateData.githubInstallationId
  ) {
    return { callbackUrl, error: "github_installation_mismatch", ok: false };
  }

  const userAccessToken = await exchangeGithubUserCode({
    code: input.code,
    codeVerifier: stateData.codeVerifier,
    config: input.config,
  });
  if (userAccessToken === null) {
    return { callbackUrl, error: "github_oauth_failed", ok: false };
  }
  const installationId = stateData.githubInstallationId;
  if (!(await githubUserCanAccessInstallation(userAccessToken, installationId))) {
    return { callbackUrl, error: "github_installation_not_authorized", ok: false };
  }

  const existingClaim = await lookupConnectionClaim("github", installationId);
  if (existingClaim !== null && existingClaim.projectId !== input.projectId) {
    return {
      callbackUrl,
      error: "github_installation_already_claimed",
      githubStealState: await createGithubStealState({
        callbackUrl: stateData.callbackUrl,
        installationId,
        projectId: input.projectId,
        userId: stateData.userId,
      }),
      ok: false,
    };
  }

  // The user token above is proof only and is discarded. The durable
  // connection still acts as the App installation. A fresh connection name
  // fences delayed cleanup from every previous ownership generation; the
  // public installation id remains in the refresh strategy, and the Secret DO
  // mints its short-lived installation token with the platform App key.
  const connection = existingClaim?.connection || newGithubConnectionName(installationId);
  await recordGithubConnection({
    connection,
    directoryClaim: { externalId: installationId },
    githubAppId: github.appId,
    installationId,
    projectId: input.projectId,
  });

  // The directory fold preserves the first live project owner. Re-check after
  // append to close the race where two projects both observed an unclaimed
  // installation: the losing project's connection is immediately bricked and
  // marked disconnected, so it cannot mint or use an installation token.
  const recordedClaim = await lookupConnectionClaim("github", installationId);
  if (recordedClaim?.projectId !== input.projectId || recordedClaim.connection !== connection) {
    await disconnectGithub({ connection, projectId: input.projectId });
    return {
      callbackUrl,
      error: "github_installation_already_claimed",
      githubStealState: await createGithubStealState({
        callbackUrl: stateData.callbackUrl,
        installationId,
        projectId: input.projectId,
        userId: stateData.userId,
      }),
      ok: false,
    };
  }

  return { callbackUrl, ok: true };
}

function createGithubStealState(input: {
  callbackUrl?: string;
  installationId: string;
  projectId: string;
  userId: string;
}): Promise<string> {
  return createOAuthState(
    {
      callbackUrl: input.callbackUrl,
      githubInstallationAuthorized: true,
      githubInstallationId: input.installationId,
      projectId: input.projectId,
      provider: "github",
      userId: input.userId,
    },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
}

/**
 * Complete the explicit dashboard confirmation for moving a GitHub App
 * installation. The signed state was minted only after GitHub user OAuth
 * proved access to the installation; this call re-verifies its target project
 * and user before changing either project.
 */
export async function confirmGithubSteal(input: {
  config: AppConfig;
  projectId: string;
  state: string;
  userId: string;
}): Promise<{ connection: string; ok: true }> {
  const stateData = await verifyOAuthState(
    { provider: "github", state: input.state },
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (
    stateData === null ||
    stateData.projectId !== input.projectId ||
    stateData.userId !== input.userId ||
    stateData.githubInstallationAuthorized !== true ||
    stateData.githubInstallationId === undefined
  ) {
    throw new Error("Invalid or expired GitHub installation move confirmation.");
  }

  const installationId = stateData.githubInstallationId;
  const github = requireGithubConfig(input.config);
  if (!github.appId) throw new Error("GitHub App is not configured.");
  const existingClaim = await lookupConnectionClaim("github", installationId);
  if (
    existingClaim?.projectId === input.projectId &&
    (await restoreOwnedGithubConnection({
      connection: existingClaim.connection,
      githubAppId: github.appId,
      installationId,
      projectId: input.projectId,
    }))
  ) {
    return { connection: existingClaim.connection, ok: true };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existingClaim = await lookupConnectionClaim("github", installationId);
    if (existingClaim?.projectId === input.projectId) {
      if (
        await restoreOwnedGithubConnection({
          connection: existingClaim.connection,
          githubAppId: github.appId,
          installationId,
          projectId: input.projectId,
        })
      ) {
        return { connection: existingClaim.connection, ok: true };
      }
      continue;
    }

    // A connection name is an ownership fence, not only a display label.
    // Every claim attempt gets a new one so cleanup delayed from an older
    // transfer can brick only that older generation after this project (or a
    // foreign project) has reclaimed and returned success.
    const connection = newGithubConnectionName(installationId);
    await recordGithubConnection({
      connection,
      directoryClaim: null,
      githubAppId: github.appId,
      installationId,
      projectId: input.projectId,
    });
    const claim = await lookupConnectionClaim("github", installationId);
    if (claim?.projectId === input.projectId) {
      await recordDisconnection({
        connection,
        disconnectedEvent: {
          type: "events.iterate.com/github/disconnected",
          payload: {
            connection,
            projectId: input.projectId,
            reason: "installation-move-race-lost",
          },
        },
        projectId: input.projectId,
        secretPath: githubConnectionSecretPath(connection),
        slug: "github",
      });
      if (
        await restoreOwnedGithubConnection({
          connection: claim.connection,
          githubAppId: github.appId,
          installationId,
          projectId: input.projectId,
        })
      ) {
        return { connection: claim.connection, ok: true };
      }
      continue;
    }
    await appendConnectionDirectoryEvents([
      ...(claim === null
        ? []
        : [
            {
              claimed: false,
              connection: claim.connection,
              externalId: installationId,
              projectId: claim.projectId,
              slug: "github",
            },
          ]),
      {
        claimed: true,
        connection,
        externalId: installationId,
        projectId: input.projectId,
        slug: "github",
      },
    ]);
    if (claim !== null) {
      // Clean every owner this confirmation attempted to displace, not only
      // the owner from the attempt that finally verifies. Another stealer can
      // take ownership between this atomic directory batch and the read below;
      // a retry must not leave the earlier owner's installation secret live.
      await recordDisconnection({
        connection: claim.connection,
        disconnectedEvent: {
          type: "events.iterate.com/github/disconnected",
          payload: {
            connection: claim.connection,
            projectId: claim.projectId,
            reason: "stolen-by-another-project",
          },
        },
        projectId: claim.projectId,
        secretPath: githubConnectionSecretPath(claim.connection),
        slug: "github",
      });
    }
    const recordedClaim = await lookupConnectionClaim("github", installationId);
    if (recordedClaim?.projectId === input.projectId && recordedClaim.connection === connection) {
      if (
        await restoreOwnedGithubConnection({
          connection,
          githubAppId: github.appId,
          installationId,
          projectId: input.projectId,
        })
      ) {
        return { connection, ok: true };
      }
      continue;
    }
    await recordDisconnection({
      connection,
      disconnectedEvent: {
        type: "events.iterate.com/github/disconnected",
        payload: {
          connection,
          projectId: input.projectId,
          reason: "installation-move-race-lost",
        },
      },
      projectId: input.projectId,
      secretPath: githubConnectionSecretPath(connection),
      slug: "github",
    });
  }

  const recordedClaim = await lookupConnectionClaim("github", installationId);
  if (recordedClaim?.projectId === input.projectId) {
    if (
      await restoreOwnedGithubConnection({
        connection: recordedClaim.connection,
        githubAppId: github.appId,
        installationId,
        projectId: input.projectId,
      })
    ) {
      return { connection: recordedClaim.connection, ok: true };
    }
  }

  throw new Error("GitHub installation ownership changed repeatedly; please try again.");
}

async function recordGithubConnection(input: {
  connection: string;
  directoryClaim: { externalId: string } | null;
  githubAppId: string;
  installationId: string;
  projectId: string;
}): Promise<void> {
  const secret = githubConnectionSecret({
    githubAppId: input.githubAppId,
    installationId: input.installationId,
  });
  await recordConnection({
    connection: input.connection,
    projectId: input.projectId,
    slug: "github",
    secrets: [
      {
        ...secret,
        path: githubConnectionSecretPath(input.connection),
      },
    ],
    connectedEvent: githubConnectedEvent(input),
    ...(input.directoryClaim ? { directoryClaim: input.directoryClaim } : {}),
  });
}

/**
 * A concurrent stealer can brick this project's secret after it briefly owns
 * the directory claim. Restore the credential, then prove the exact fenced
 * connection still owns the claim. If not, brick that obsolete generation
 * again before the caller retries.
 */
async function restoreOwnedGithubConnection(input: {
  connection: string;
  githubAppId: string;
  installationId: string;
  projectId: string;
}): Promise<boolean> {
  const secret = githubConnectionSecret(input);
  await itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({
      path: githubConnectionSecretPath(input.connection),
      projectId: input.projectId,
    }),
  ).update({
    egress: { urls: [...secret.egressUrls] },
    material: secret.material,
    refresh: secret.refresh,
  });
  const status = await getConnectionStatus({
    connection: input.connection,
    projectId: input.projectId,
    provider: "github",
  });
  if (!status.connected) {
    await integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("github", input.connection),
    ).append(githubConnectedEvent(input));
  }
  const restoredClaim = await lookupConnectionClaim("github", input.installationId);
  if (
    restoredClaim?.projectId === input.projectId &&
    restoredClaim.connection === input.connection
  ) {
    return true;
  }
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: "events.iterate.com/github/disconnected",
      payload: {
        connection: input.connection,
        projectId: input.projectId,
        reason: "installation-move-race-lost",
      },
    },
    projectId: input.projectId,
    secretPath: githubConnectionSecretPath(input.connection),
    slug: "github",
  });
  return false;
}

function newGithubConnectionName(installationId: string): string {
  return `install-${sanitizeConnectionName(installationId)}-${randomBase64Url(9)}`.toLowerCase();
}

function githubConnectedEvent(input: {
  connection: string;
  installationId: string;
  projectId: string;
}) {
  return {
    type: "events.iterate.com/github/connected",
    payload: {
      connection: input.connection,
      externalId: input.installationId,
      installationId: input.installationId,
      projectId: input.projectId,
    },
  };
}

function githubConnectionSecret(input: { githubAppId: string; installationId: string }) {
  return {
    egressUrls: GITHUB_CONNECTION_EGRESS_URLS,
    material: {},
    refresh: {
      kind: "github-app-installation" as const,
      apiBase: "https://api.github.com",
      appId: input.githubAppId,
      installationId: input.installationId,
      privateKey: { platform: "integrations.github" as const },
    },
  };
}

async function exchangeGithubUserCode(input: {
  code: string;
  codeVerifier?: string;
  config: AppConfig;
}): Promise<string | null> {
  const github = requireGithubConfig(input.config);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: new URLSearchParams({
      client_id: github.oauthClientId,
      client_secret: github.oauthClientSecret.exposeSecret(),
      code: input.code,
      ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
      redirect_uri: oauthRedirectUri({
        baseUrl: requestBaseUrl({ config: input.config }),
        provider: "github",
      }),
    }),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { access_token?: unknown; error?: unknown };
  return typeof data.access_token === "string" ? data.access_token : null;
}

async function githubUserCanAccessInstallation(
  userAccessToken: string,
  installationId: string,
): Promise<boolean> {
  for (let page = 1; ; page += 1) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
        "user-agent": "iterate-os",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { installations?: Array<{ id?: unknown }> };
    const installations = Array.isArray(data.installations) ? data.installations : [];
    if (installations.some((installation) => String(installation.id) === installationId)) {
      return true;
    }
    if (installations.length < 100) return false;
  }
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
      type: "events.iterate.com/google/connected",
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
// Telegram connect (no OAuth — bot-token paste + setWebhook)
// ---------------------------------------------------------------------------

/**
 * Telegram has no OAuth: the user pastes a BotFather token, and connecting is
 * getMe (validate the token + learn the bot identity) → claim check →
 * setWebhook (pointing the bot at this deployment, authenticated by a secret
 * token DERIVED from SECRET_ENCRYPTION_KEY — see telegramWebhookSecretToken)
 * → the shared {@link recordConnection}. A dedicated verb, not a contortion of
 * the startOAuthFlow/completeConnect state machinery: there is no redirect,
 * no callback, and no signed state to verify. Failures throw — the caller is
 * a direct RPC (the dashboard's connect dialog), not a redirect chain — with
 * ONE exception: a bot already claimed by another project answers a
 * structured `ok: false` arm so the dashboard can offer the steal.
 *
 * A Telegram bot has exactly one webhook, so one bot serves one project at a
 * time. `steal: true` MOVES it: possession of the token IS the authorization
 * (only the bot's owner has it — the confirmation is a foot-gun gate, not
 * authz), so after getMe re-validates the token, the old project is
 * dispossessed via the shared {@link recordDisconnection} (its stored token
 * becomes unusable, its dashboard shows disconnected, its directory claim is
 * cleared) and the normal connect proceeds for the caller. deleteWebhook is
 * deliberately skipped on the old side — the webhook is re-registered for
 * this same bot moments later.
 */
export type ConnectTelegramResult =
  | { botId: string; botUsername: string | null; connection: string; ok: true }
  /** The bot is claimed by another project (never named — the caller may be a
   * different org). Retry with `steal: true` to move it. */
  | { botUsername: string | null; error: "telegram_bot_already_claimed"; ok: false };

export async function connectTelegram(input: {
  botToken: string;
  config: AppConfig;
  projectId: string;
  steal?: boolean;
}): Promise<ConnectTelegramResult> {
  const botToken = input.botToken.trim();
  if (!botToken) throw new Error("A Telegram bot token is required (get one from @BotFather).");
  const apiBaseUrl = telegramApiBaseUrl(input.config);
  const baseUrl = requestBaseUrl(input);

  const bot = await telegramGetMe({ apiBaseUrl, botToken });

  const existingClaim = await lookupConnectionClaim("telegram", bot.id);
  const foreignClaim =
    existingClaim !== null && existingClaim.projectId !== input.projectId ? existingClaim : null;
  if (foreignClaim !== null && input.steal !== true) {
    return { botUsername: bot.username ?? null, error: "telegram_bot_already_claimed", ok: false };
  }
  // Same-project reconnects reuse the claiming connection's name; fresh
  // connects (steals included — the old name belonged to the old project)
  // derive it from the bot username (or the bot id when the username
  // sanitizes away).
  const connection =
    (foreignClaim === null ? existingClaim?.connection : undefined) ??
    (sanitizeConnectionName(bot.username ?? "") || `bot-${sanitizeConnectionName(bot.id)}`);

  // Record BEFORE setWebhook — claim-first, so no update can arrive at the
  // door before its claim exists. A fresh bot has no traffic until setWebhook
  // registers, and a stolen bot's traffic keeps routing (old claim, then the
  // atomic swap) the whole way through; an update landing between the claim
  // and setWebhook simply routes to the just-recorded connection. The old
  // order (setWebhook first) had a real loss window on steal: claim-less
  // updates are ACK-200-dropped and Telegram never retries an ACK.
  //
  // Steal ordering inside this call is deliberate too: recordConnection
  // prepares the NEW connection completely (secret, connected fact, router
  // arm) and the atomic [unclaim old, claim new] directory swap comes LAST —
  // so the instant routing flips, the new connection is fully ready, and
  // until it flips the old project keeps a WORKING token (its dispossession
  // happens after, below). No window routes to a bricked handler.
  await recordConnection({
    connection,
    projectId: input.projectId,
    slug: "telegram",
    secrets: [
      {
        // The Bot API host is the only place this token is ever useful.
        egressUrls: [new URL(apiBaseUrl).origin],
        material: botToken,
        path: telegramBotTokenSecretPath(connection),
      },
    ],
    // No idempotency keys on the connected/claim facts — same reasoning as
    // Slack: a disconnect->reconnect cycle must append fresh facts.
    connectedEvent: {
      type: "events.iterate.com/telegram/connected",
      payload: {
        botFirstName: bot.firstName,
        botId: bot.id,
        botUsername: bot.username,
        connection,
        externalId: bot.id,
        projectId: input.projectId,
      },
    },
    processorSubscription: {
      processorSlug: TelegramProcessorContract.slug,
    },
    directoryClaim: {
      externalId: bot.id,
      ...(foreignClaim === null
        ? {}
        : {
            unclaimFirst: {
              connection: foreignClaim.connection,
              projectId: foreignClaim.projectId,
            },
          }),
    },
  });

  if (foreignClaim !== null) {
    // Dispossess the old project AFTER the swap: brick its stored token
    // (egress emptied) and append its disconnected fact. Its directory claim
    // is already gone (the atomic swap above), so no unclaim here. The old
    // project keeps a live token for the sub-second between swap and brick —
    // accepted, and actually good: in-flight replies to pre-swap messages
    // drain gracefully, and it receives nothing new. Its dashboard is
    // momentarily stale (still "connected") until this fact lands — harmless.
    await recordDisconnection({
      connection: foreignClaim.connection,
      disconnectedEvent: {
        type: "events.iterate.com/telegram/disconnected",
        payload: {
          botId: bot.id,
          botUsername: bot.username,
          connection: foreignClaim.connection,
          externalId: bot.id,
          projectId: foreignClaim.projectId,
          // Breadcrumb for the old project's journal; deliberately does NOT
          // name the project that took the bot.
          reason: "stolen-by-another-project",
        },
      },
      projectId: foreignClaim.projectId,
      secretPath: telegramBotTokenSecretPath(foreignClaim.connection),
      slug: "telegram",
    });
  }

  try {
    const secretToken = await telegramWebhookSecretToken({
      botId: bot.id,
      keyMaterial: itxEnv.SECRET_ENCRYPTION_KEY,
    });
    await callTelegramWithToken({
      apiBaseUrl,
      body: {
        secret_token: secretToken,
        url: `${baseUrl}/api/integrations/telegram/webhook/${bot.id}`,
      },
      botToken,
      method: "setWebhook",
    });
  } catch (error) {
    // Roll the just-recorded connection back (best-effort) so the dashboard
    // never shows a half-connected bot whose webhook was never registered; a
    // retry re-runs cleanly (the reconnect path reuses the connection name).
    // The deleteWebhook is defense in depth for partial/ambiguous failures
    // (a webhook that DID register while the response failed would otherwise
    // keep delivering to a deployment that ACK-drops the unclaimed bot).
    // Steal note: the OLD project is not restored — its token was already
    // bricked above and re-claiming it would resurrect a connection whose
    // secret is dead; the truthful state is "nobody holds the bot, retry".
    await callTelegramWithToken({
      apiBaseUrl,
      body: {},
      botToken,
      method: "deleteWebhook",
    }).catch(() => null);
    await recordDisconnection({
      connection,
      disconnectedEvent: {
        type: "events.iterate.com/telegram/disconnected",
        payload: {
          botId: bot.id,
          connection,
          externalId: bot.id,
          projectId: input.projectId,
          reason: "webhook-registration-failed",
        },
      },
      projectId: input.projectId,
      secretPath: telegramBotTokenSecretPath(connection),
      slug: "telegram",
      unclaimExternalId: bot.id,
    }).catch(() => null);
    throw error;
  }

  // Advertise /new in the chat's `/` command menu (the session-rotation verb
  // the telegram router understands) — BEST-EFFORT: the menu is cosmetic
  // (routing understands /new regardless), so its failure must never fail —
  // let alone roll back — a connect whose webhook is already live.
  // Already-connected bots pick the menu up on reconnect.
  await callTelegramWithToken({
    apiBaseUrl,
    body: {
      commands: [
        { command: "new", description: "Start a fresh thread" },
        { command: "debug", description: "Show agent debug info" },
      ],
    },
    botToken,
    method: "setMyCommands",
  }).catch(() => null);

  return { botId: bot.id, botUsername: bot.username ?? null, connection, ok: true };
}

/** What `getMe` said about the pasted token's bot. The numeric id is the
 * stable identity (usernames can change) — it is the directory external id,
 * the webhook path segment, and the secret-token derivation input. */
type TelegramBotIdentity = { firstName?: string; id: string; username?: string };

/** Validate the pasted token against the live Bot API and read the bot's
 * identity. Runs with the raw token (the connect flow holds it by definition,
 * exactly as the OAuth flows hold their freshly exchanged access tokens). */
async function telegramGetMe(input: {
  apiBaseUrl: string;
  botToken: string;
}): Promise<TelegramBotIdentity> {
  const me = await callTelegramWithToken({ ...input, body: {}, method: "getMe" });
  const result = readRecord(me.result);
  const id = result?.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new Error("Telegram getMe returned no bot id.");
  }
  const username = readString(result?.username);
  const firstName = readString(result?.first_name);
  return {
    ...(firstName === undefined ? {} : { firstName }),
    id: String(id),
    ...(username === undefined ? {} : { username }),
  };
}

async function callTelegramWithToken(input: {
  apiBaseUrl: string;
  body: Record<string, unknown>;
  botToken: string;
  method: string;
}): Promise<{ description?: string; ok?: boolean; result?: unknown }> {
  const response = await fetch(`${input.apiBaseUrl}/bot${input.botToken}/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const data = (await response.json().catch(() => null)) as {
    description?: string;
    ok?: boolean;
    result?: unknown;
  } | null;
  if (data === null || !response.ok || data.ok !== true) {
    // 401 here means the pasted token is wrong — the one failure users hit.
    const reason =
      data?.description ??
      (response.status === 401 ? "invalid bot token" : `HTTP ${response.status}`);
    throw new Error(`Telegram ${input.method} failed: ${reason}`);
  }
  return data;
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
  const event = await latestStreamEventOfTypes(input.projectId, path, [
    input.connectedType,
    input.disconnectedType,
  ]);
  return event === null
    ? null
    : {
        connected: event.type === input.connectedType,
        payload: readRecord(event.payload) ?? {},
      };
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
        connectedType: "events.iterate.com/slack/connected",
        connection: input.connection,
        disconnectedType: "events.iterate.com/slack/disconnected",
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
        connectedType: "events.iterate.com/github/connected",
        connection: input.connection,
        disconnectedType: "events.iterate.com/github/disconnected",
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
    case "telegram": {
      const fact = await latestLifecycleFact({
        connectedType: "events.iterate.com/telegram/connected",
        connection: input.connection,
        disconnectedType: "events.iterate.com/telegram/disconnected",
        projectId: input.projectId,
        slug: "telegram",
      });
      if (!fact) return notConnectedStatus();
      const botUsername = readString(fact.payload.botUsername);
      return {
        connected: fact.connected,
        displayName: botUsername === undefined ? null : `@${botUsername}`,
        externalId: readString(fact.payload.externalId) ?? null,
        metadata: {
          botFirstName: readString(fact.payload.botFirstName),
          botId: readString(fact.payload.botId),
          botUsername,
        },
      };
    }
    case "google": {
      const fact = await latestLifecycleFact({
        connectedType: "events.iterate.com/google/connected",
        connection: input.connection,
        disconnectedType: "events.iterate.com/google/disconnected",
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
    case "waitrose": {
      // Waitrose has no connect flow and journals no lifecycle facts: a
      // connection IS its session secret (username/password + the
      // waitrose-session refresh strategy), so status is whether that secret
      // currently holds material. describe() answers hasMaterial only, never
      // the ciphertext.
      const description = await itxEnv.SECRET.getByName(
        DurableObjectNameCodec.stringify({
          path: waitroseSessionSecretPath(input.connection),
          projectId: input.projectId,
        }),
      )
        .describe()
        .catch(() => null);
      if (!description?.hasMaterial) return notConnectedStatus();
      return {
        connected: true,
        displayName: input.connection,
        externalId: null,
        metadata: {},
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
    case "telegram":
      return await disconnectTelegram(input);
    case "waitrose":
      return await disconnectWaitrose(input);
  }
}

/**
 * Waitrose has nothing provider-side to revoke (no refresh grant, no webhook)
 * and no lifecycle fact to append (nothing was journaled on connect — the
 * connection is its secret): disconnect just makes the stored credential
 * unusable by emptying the connection secret's egress allowlist, the same
 * secret half every other disconnect performs.
 */
async function disconnectWaitrose(input: {
  connection: string;
  projectId: string;
}): Promise<{ success: true }> {
  await itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({
      path: waitroseSessionSecretPath(input.connection),
      projectId: input.projectId,
    }),
  )
    .update({ egress: { urls: [] } })
    .catch(() => null);
  return { success: true };
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
    streamContext: { kind: "scope", scopePath: "/" },
  }).catch(() => null);
  const teamId = status.metadata.teamId as string | undefined;
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: "events.iterate.com/slack/disconnected",
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
      type: "events.iterate.com/github/disconnected",
      payload: { connection: input.connection, projectId: input.projectId },
    },
    projectId: input.projectId,
    secretPath: githubConnectionSecretPath(input.connection),
    slug: "github",
    unclaimExternalId: status.externalId ?? undefined,
  });
  return { success: true };
}

async function disconnectTelegram(input: {
  connection: string;
  projectId: string;
}): Promise<{ success: true }> {
  const status = await getConnectionStatus({ ...input, provider: "telegram" });
  // Best-effort deleteWebhook so Telegram stops delivering (the secret-
  // substituted egress path — no material read), like Slack's auth.revoke.
  // Must run BEFORE recordDisconnection empties the egress allowlist.
  await callProjectTelegramBotApi({
    body: {},
    connection: input.connection,
    method: "deleteWebhook",
    projectId: input.projectId,
    streamContext: { kind: "scope", scopePath: "/" },
  }).catch(() => null);
  const botId = status.metadata.botId as string | undefined;
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: "events.iterate.com/telegram/disconnected",
      payload: {
        botId,
        botUsername: (status.metadata.botUsername as string | undefined) ?? undefined,
        connection: input.connection,
        externalId: status.externalId ?? undefined,
        projectId: input.projectId,
      },
    },
    projectId: input.projectId,
    secretPath: telegramBotTokenSecretPath(input.connection),
    slug: "telegram",
    unclaimExternalId: botId,
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
      type: "events.iterate.com/google/disconnected",
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
