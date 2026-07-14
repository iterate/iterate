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
  buildIntegrationRouterSubscriptionConfiguredEvent,
  integrationStreamStub,
  latestStreamEventOfTypes,
  lookupConnectionClaim,
} from "./integration-streams.ts";
import { callProjectSlackWebApi } from "./slack-api.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";
import { callProjectTelegramBotApi, telegramApiBaseUrl } from "./telegram-api.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";
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
  TELEGRAM_CONNECTED_EVENT_TYPE,
  TELEGRAM_DISCONNECTED_EVENT_TYPE,
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
    return { callbackUrl, error: "github_installation_already_claimed", ok: false };
  }

  // The user token above is proof only and is discarded. The durable
  // connection still acts as the App installation: the public installation id
  // names the connection and refresh strategy, and the Secret DO mints its
  // short-lived installation token with the platform App key on first use.
  const connection =
    existingClaim?.connection ?? `install-${sanitizeConnectionName(installationId)}`;
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
          installationId,
          privateKey: { platform: "integrations.github" },
        },
      },
    ],
    connectedEvent: {
      type: GITHUB_CONNECTED_EVENT_TYPE,
      payload: {
        connection,
        externalId: installationId,
        installationId,
        projectId: input.projectId,
      },
    },
    directoryClaim: { externalId: installationId },
  });

  // The directory fold preserves the first live project owner. Re-check after
  // append to close the race where two projects both observed an unclaimed
  // installation: the losing project's connection is immediately bricked and
  // marked disconnected, so it cannot mint or use an installation token.
  const recordedClaim = await lookupConnectionClaim("github", installationId);
  if (recordedClaim?.projectId !== input.projectId || recordedClaim.connection !== connection) {
    await disconnectGithub({ connection, projectId: input.projectId });
    return { callbackUrl, error: "github_installation_already_claimed", ok: false };
  }

  return { callbackUrl, ok: true };
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
      type: TELEGRAM_CONNECTED_EVENT_TYPE,
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
        type: TELEGRAM_DISCONNECTED_EVENT_TYPE,
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
        type: TELEGRAM_DISCONNECTED_EVENT_TYPE,
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
    case "telegram": {
      const fact = await latestLifecycleFact({
        connectedType: TELEGRAM_CONNECTED_EVENT_TYPE,
        connection: input.connection,
        disconnectedType: TELEGRAM_DISCONNECTED_EVENT_TYPE,
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
  }).catch(() => null);
  const botId = status.metadata.botId as string | undefined;
  await recordDisconnection({
    connection: input.connection,
    disconnectedEvent: {
      type: TELEGRAM_DISCONNECTED_EVENT_TYPE,
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
