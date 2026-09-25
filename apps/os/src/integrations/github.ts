// src/integrations/github.ts — GITHUB: a connection is one GitHub App installation (connections.ts).
// Its secret `/secrets/github-<connection>` holds no token until first use: its
// `github-app-installation` strategy mints the installation's token (secret/durable-object.ts), with
// iterate's App key (APP_CONFIG `integrations.github`) or, for a project's own App, the `appId` and
// `privateKey` the secret itself holds beside `clientSecret` and `webhookSecret`. Outbound is the
// real SDK with the placeholder as its token:
// `new Octokit({ auth: 'getSecret("/secrets/github-acme", { field: "accessToken" })' })`.
//   connectGithub        → the App's install page, with a platform-signed `state`
//   githubCallbackRoute  → `GET /api/integrations/github/callback`, the App's Callback URL (and the
//                          legacy Setup URL): the project facet's `acceptGithubCallback`, which
//     - with a `code` (GitHub's "Request user authorization (OAuth) during installation" sends it
//       beside `installation_id` in one redirect): trades it for a user token, keeps the
//       installation only if the human administers its account (rules.ts), sets the secret, routes
//       the installation here for iterate's App, mints once as proof, `github/connected` on `/`;
//     - with an `installation_id` alone (the App's Setup URL, or an update): sends the human on to
//       authorize the App, and comes back with a `code`;
//     - with `setup_action=request`: an organization owner has yet to approve the install.
//   disconnectGithub     → the route released, the secret deleted, `github/disconnected` (the App
//                          stays installed; only its account can uninstall it)
//   githubWebhookRoute   → `POST /api/integrations/github/webhook` (iterate's App, routed) and
//                          `…/webhook/<projectId>/<connection>` (a project's own App)
import { codedError } from "iterate/lib";
import { signClaims, verifyClaims } from "../caller.ts";
import { appConfigOf, sessionSigningSecretOf, type PlatformAddresses } from "../app-config.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import { callbackAuthorization } from "../secret-oauth-callback.ts";
import { nextUrlOf, SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import { isRecord, verifySecretHmac } from "../secrets.ts";
import {
  appendPlatformFact,
  attemptKeyOf,
  connectionPathOf,
  connectionRowOf,
  ignoredWebhook,
  ownerEgress,
  routedWhile,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";
import {
  githubInstallationIdOf,
  githubInstallationRefusal,
  githubSignatureValid,
  type HmacHexMatches,
} from "./rules.ts";

const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback";

/** Where GitHub's REST API answers for a GitHub origin: `https://api.github.com` for github.com; any
 *  other origin (a fake's) serves its API itself. */
export function githubApiOriginOf(githubOrigin: string): string {
  return githubOrigin === "https://github.com" ? "https://api.github.com" : githubOrigin;
}

/** A GitHub connect in flight: the attempt's current nonce, the App's public half, where the human
 *  lands at the end and, once GitHub named it, the (untrusted) installation. */
type GithubAttempt = ConnectionAttempt & {
  nonce: string;
  appSlug: string;
  clientId: string;
  next: string | null;
  installationId?: string;
  /** The `redirect_uri` the authorize fallback named, which the code exchange repeats (RFC 6749
   *  4.1.3); an install redirect's code names none. */
  redirectUri?: string;
};

/** The platform-signed `state` both GitHub redirects carry back. */
type GithubConnectState = {
  kind: "github-connect";
  projectId: string;
  connection: string;
  nonce: string;
  exp: number;
};

async function signedState(scope: IntegrationScope, connection: string, attempt: GithubAttempt) {
  const state: GithubConnectState = {
    kind: "github-connect",
    projectId: scope.projectId,
    connection,
    nonce: attempt.nonce,
    exp: attempt.until,
  };
  return signClaims(state, await sessionSigningSecretOf(appConfigOf(scope.env)));
}

export async function connectGithub(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    /** A project's own App's public half (its URL slug and OAuth client id); iterate's is config. */
    appSlug?: string;
    clientId?: string;
  },
): Promise<{ authorizationUrl: string }> {
  const { connection, client } = input;
  const config = appConfigOf(scope.env);
  let app: { origin: string; appSlug: string; clientId: string };
  if (client === "iterate") {
    const github = config.integrations.github;
    if (!github)
      throw codedError(
        "INVALID_INPUT",
        "This deployment has no GitHub App (APP_CONFIG integrations.github) — use your own.",
      );
    app = { origin: github.githubOrigin, appSlug: github.appSlug, clientId: github.oauthClientId };
  } else {
    const secretPath = tokenSecretPathOf("github", connection);
    const secrets = await scope.withItx((itx) => itx.secrets.list());
    const pin = secrets.find((secret) => secret.path === secretPath)?.urls[0];
    if (!pin || !input.appSlug || !input.clientId)
      throw codedError(
        "INVALID_INPUT",
        `Set ${secretPath} to your GitHub App's { appId, clientId, clientSecret, privateKey, webhookSecret }, pinned to https://github.com and https://api.github.com, and pass its appSlug and clientId.`,
      );
    app = { origin: pin, appSlug: input.appSlug, clientId: input.clientId };
  }
  const attempt: GithubAttempt = {
    client,
    ...app,
    nonce: crypto.randomUUID(),
    until: Date.now() + SECRET_OAUTH_TTL_MS,
    // checked when GitHub sends the human back, against the origin that request reached the
    // platform on (a self-host names no `urls.os`, and the project facet knows no request)
    next: input.next || null,
  };
  await scope.storage.put(attemptKeyOf("github", connection), attempt);
  const install = new URL(
    `${app.origin}/apps/${encodeURIComponent(app.appSlug)}/installations/new`,
  );
  install.searchParams.set("state", await signedState(scope, connection, attempt));
  return { authorizationUrl: install.href };
}

/** GitHub's redirect back, as the callback hands it over (the header's three cases), with the
 *  platform origin the callback reached (`PlatformAddresses`). Answers where the human goes next. */
export async function acceptGithubCallback(
  scope: IntegrationScope,
  input: {
    platformOrigin: string;
    connection: string;
    nonce: string;
    installationId?: string;
    code?: string;
    setupAction?: string;
  },
): Promise<{ redirect: string | null }> {
  const { env, projectId } = scope;
  const { connection } = input;
  const key = attemptKeyOf("github", connection);
  const attempt = await scope.storage.get<GithubAttempt>(key);
  if (!attempt || attempt.nonce !== input.nonce || attempt.until < Date.now())
    throw codedError(
      "INVALID_INPUT",
      "This link is not the connection's current attempt — connect again.",
    );
  if (input.setupAction === "request")
    throw codedError(
      "INVALID_INPUT",
      "GitHub asked an owner of the account to approve the install. Connect again once they have.",
    );
  const installationId = input.installationId || attempt.installationId || "";
  if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
    throw codedError("INVALID_INPUT", "GitHub sent no installation_id.");
  // the human's way back, on the platform's origin as this request reached it or on the Dash's
  let landing: string | null;
  try {
    landing = nextUrlOf(
      attempt.next,
      [input.platformOrigin, appConfigOf(env).urls.dash].filter(Boolean),
    );
  } catch (error) {
    throw codedError(
      "INVALID_INPUT",
      `GitHub: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const callbackUrl = `${input.platformOrigin}${GITHUB_CALLBACK_PATH}`;
  if (!input.code) {
    // No code yet: the human authorizes the App as themself, a fresh nonce binding the two redirects.
    const next: GithubAttempt = {
      ...attempt,
      nonce: crypto.randomUUID(),
      installationId,
      redirectUri: callbackUrl,
    };
    await scope.storage.put(key, next);
    const authorize = new URL(`${attempt.origin}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", attempt.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl);
    authorize.searchParams.set("state", await signedState(scope, connection, next));
    return { redirect: authorize.href };
  }
  const apiOrigin = githubApiOriginOf(attempt.origin);
  const userToken = await githubUserTokenOf(scope, connection, attempt, input.code);
  const github = (path: string) =>
    fetch(`${apiOrigin}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userToken}`,
        "user-agent": "iterate",
      },
    }).then(async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub's ${path} answered ${response.status}`);
      const data: unknown = await response.json();
      return isRecord(data) ? data : null;
    });
  const user = await github("/user");
  // every page of the user's installations until this one (GitHub pages them at most 100 each)
  let installation: unknown;
  for (let page = 1; !installation; page++) {
    const listed = await github(`/user/installations?per_page=100&page=${page}`);
    const installations: unknown[] = Array.isArray(listed?.installations)
      ? listed.installations
      : [];
    installation = installations.find(
      (candidate) => isRecord(candidate) && String(candidate.id) === installationId,
    );
    if (installations.length < 100) break;
  }
  const account =
    isRecord(installation) && isRecord(installation.account) ? installation.account : null;
  const login = String(account?.login);
  const membership =
    account?.type === "Organization"
      ? await github(`/user/memberships/orgs/${encodeURIComponent(login)}`)
      : null;
  const refusal = githubInstallationRefusal({
    user: { id: Number(user?.id) },
    account: account && { id: Number(account.id), login, type: String(account.type) },
    membership: membership && { state: String(membership.state), role: String(membership.role) },
  });
  if (refusal) throw codedError("INVALID_INPUT", `GitHub: ${refusal}.`);

  // The user token was proof only; the connection acts as the installation from here on. A
  // project's own App's secret keeps its material (the App's key) and gains the strategy.
  const secretPath = tokenSecretPathOf("github", connection);
  const path = connectionPathOf("github", connection);
  const secrets = await scope.withItx((itx) => itx.secrets.list());
  const urls = secrets.find((secret) => secret.path === secretPath)?.urls ?? [apiOrigin];
  const mintFor = (id: string) =>
    scope.withItx((itx) =>
      itx.secrets.set(
        secretPath,
        {},
        {
          urls,
          refresh: {
            kind: "github-app-installation",
            apiOrigin,
            installationId: id,
            client: attempt.client === "iterate" ? { platform: "github" } : { project: "github" },
          },
          merge: true,
        },
      ),
    );
  // A reconnect to another installation that fails to land mints for the one it had again, as
  // `routedWhile` routes it back.
  const before = await connectionRowOf(env, projectId, path);
  // The proof mint and `connected` land with the installation routed here (iterate's App); a
  // failure puts the connection's routes back as they were.
  const land = async () => {
    await mintFor(installationId);
    try {
      await prove();
    } catch (error) {
      if (before?.externalId && before.externalId !== installationId)
        await mintFor(before.externalId);
      throw error;
    }
  };
  const prove = async () => {
    const proof = await ownerEgress(
      env,
      scope,
      new Request(`${apiOrigin}/installation/repositories?per_page=1`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer getSecret("${secretPath}", { field: "accessToken" })`,
          "user-agent": "iterate",
        },
      }),
    );
    if (!proof.ok)
      throw new Error(
        `Minting the installation's token failed (${proof.status}): ${(await proof.text()).slice(0, 300)}`,
      );
    await proof.body?.cancel();
    await appendPlatformFact(env, projectId, "/", {
      type: "events.iterate.com/github/connected",
      payload: {
        connection,
        client: attempt.client,
        account: login,
        externalId: installationId,
      },
    });
  };
  if (attempt.client === "iterate")
    await routedWhile(
      env,
      { provider: "github", externalId: installationId, projectId, path },
      land,
    );
  else await land();
  await scope.storage.delete(key);
  return { redirect: landing };
}

/** The human's user token for the code: iterate's App's client secret from APP_CONFIG, a project's
 *  own App's substituted by egress from its secret (so neither ever leaves where it is kept). GitHub
 *  takes the client credentials as query parameters. */
async function githubUserTokenOf(
  scope: IntegrationScope,
  connection: string,
  attempt: GithubAttempt,
  code: string,
): Promise<string> {
  const exchange = new URL(`${attempt.origin}/login/oauth/access_token`);
  exchange.searchParams.set("client_id", attempt.clientId);
  exchange.searchParams.set("code", code);
  if (attempt.redirectUri) exchange.searchParams.set("redirect_uri", attempt.redirectUri);
  const request = (clientSecret: string) =>
    new Request(`${exchange.href}&client_secret=${clientSecret}`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
  const github = appConfigOf(scope.env).integrations.github;
  const response =
    attempt.client === "iterate"
      ? await fetch(request(encodeURIComponent(github?.oauthClientSecret.exposeSecret() ?? "")))
      : await ownerEgress(
          scope.env,
          scope,
          request(
            `getSecret("${tokenSecretPathOf("github", connection)}", { field: "clientSecret" })`,
          ),
        );
  const data: unknown = await response.json().catch(() => null);
  if (!isRecord(data) || typeof data.access_token !== "string")
    throw codedError(
      "INVALID_INPUT",
      `GitHub refused the authorization code (${isRecord(data) ? String(data.error) : response.status}).`,
    );
  return data.access_token;
}

export async function disconnectGithub(scope: IntegrationScope, connection: string): Promise<void> {
  const { env, projectId } = scope;
  await new ControlPlane(env).releaseIntegrationRoutes(
    projectId,
    connectionPathOf("github", connection),
  );
  await scope
    .withItx((itx) => itx.secrets.delete(tokenSecretPathOf("github", connection)))
    .catch(() => {});
  await scope.storage.delete(attemptKeyOf("github", connection));
  await appendPlatformFact(env, projectId, scope.rootPath, {
    type: "events.iterate.com/github/disconnected",
    payload: { connection },
  });
}

/** Where GitHub sends the human back, or null when the path is not the callback's. The signed
 *  `state` names the project and the connection; the human must be signed in to a session that
 *  reaches that project, and the project facet does the rest (`acceptGithubCallback`). */
export async function githubCallbackRoute(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_CALLBACK_PATH) return null;
  const answer = (status: number, text: string) =>
    new Response(`${text}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const signedState = url.searchParams.get("state");
  if (!signedState)
    // an installation GitHub updated (`setup_action=update`) carries no state of ours
    return answer(200, "GitHub updated the app's installation. You can close this tab.");
  const claims = await verifyClaims(signedState, await sessionSigningSecretOf(appConfigOf(env)));
  if (
    !isRecord(claims) ||
    claims.kind !== "github-connect" ||
    typeof claims.projectId !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp <= Date.now()
  )
    return answer(400, "This link is not one the platform issued, or it has expired.");
  const authorization = await callbackAuthorization(request, env, addresses);
  if (!authorization)
    return answer(
      401,
      "Sign in to iterate in this browser first, then open this link again — the installation connects to a project you must be a member of.",
    );
  if (!(await new ControlPlane(env).reachesProject(authorization.reach, claims.projectId)))
    return answer(403, `Your session cannot access project ${claims.projectId}.`);
  const param = (name: string) => url.searchParams.get(name) || undefined;
  if (param("error")) return answer(400, `GitHub declined: ${param("error")}`);
  let redirect: string | null;
  try {
    // The platform's own call on the project root; `invoke` is untyped across the DO hop.
    ({ redirect } = (await env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId: claims.projectId, path: "/" }),
    ).invoke(
      [
        "itx",
        "builtins",
        "facets",
        ["get", "project"],
        [
          "acceptGithubCallback",
          {
            platformOrigin: addresses.platformOrigin,
            connection: claims.connection,
            nonce: claims.nonce,
            installationId: param("installation_id"),
            code: param("code"),
            setupAction: param("setup_action"),
          },
        ],
      ],
      [],
      { principal: null },
    )) as { redirect: string | null });
  } catch (error) {
    return answer(
      400,
      `Connecting GitHub failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (redirect)
    return new Response(null, {
      status: 303,
      headers: { location: redirect, "cache-control": "no-store" },
    });
  return answer(200, "Done: GitHub is connected. You can close this tab.");
}

const GITHUB_WEBHOOK_PATH = /^\/api\/integrations\/github\/webhook(?:\/([^/]+)\/([^/]+))?$/;

/** A GitHub delivery's response (rules.ts), or null when the path is not GitHub's. */
export async function githubWebhookRoute(request: Request, env: Env): Promise<Response | null> {
  const match = GITHUB_WEBHOOK_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const [, ownProjectId, ownConnection] = match;
  let hmacHexMatches: HmacHexMatches;
  let own: { projectId: string; path: string; externalId: string } | null = null;
  if (ownProjectId && ownConnection) {
    // A PROJECT'S OWN APP: the URL names the connection, which must be recorded as the project's
    // own before any secret is touched (a context is created on first touch).
    const project = await new ControlPlane(env).getProject(ownProjectId);
    const path = connectionPathOf("github", ownConnection);
    const row = project && (await connectionRowOf(env, project.id, path));
    if (!project || row?.client !== "project") return ignoredWebhook("unknown-connection");
    own = { projectId: project.id, path, externalId: row.externalId };
    hmacHexMatches = async (payload, signature) =>
      (await env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId: project.id, path: "/" }),
      ).invoke(
        [
          "itx",
          "builtins",
          "secrets",
          [
            "verifyHmac",
            tokenSecretPathOf("github", ownConnection),
            { payload, signature, field: "webhookSecret" },
          ],
        ],
        [],
        { principal: null },
      )) === true;
  } else {
    const github = appConfigOf(env).integrations.github;
    if (!github)
      return Response.json({ error: "GitHub integration is not configured." }, { status: 503 });
    hmacHexMatches = (payload, signature) =>
      verifySecretHmac(github.webhookSecret.exposeSecret(), { payload, signature });
  }
  const rawBody = await request.text();
  const signed = await githubSignatureValid({
    rawBody,
    signature: request.headers.get("x-hub-signature-256"),
    hmacHexMatches,
  });
  if (!signed) return Response.json({ error: "Invalid GitHub signature." }, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const eventName = request.headers.get("x-github-event")?.trim();
  if (!deliveryId || !eventName)
    return Response.json(
      { error: "Missing x-github-delivery or x-github-event." },
      { status: 400 },
    );
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {}
  if (!isRecord(body)) return ignoredWebhook("unparseable-payload");
  const installationId = githubInstallationIdOf(body);
  if (!installationId) return ignoredWebhook("no-installation");
  const route = own
    ? own.externalId === installationId
      ? own
      : null
    : await new ControlPlane(env).integrationRouteOf("github", installationId);
  if (!route) return ignoredWebhook(own ? "other-installation" : "unrouted-installation");
  await appendPlatformFact(env, route.projectId, route.path, {
    type: "events.iterate.com/github/webhook-received",
    // a redelivery is the same delivery id and body: the same event, stored once
    idempotencyKey: `github-webhook:${deliveryId}`,
    payload: { delivery: { id: deliveryId, name: eventName }, installationId, body },
  });
  return Response.json({ ok: true });
}
