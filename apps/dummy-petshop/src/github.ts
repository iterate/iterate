/**
 * A GitHub-shaped fake, served on the pet shop's origin at GitHub's own paths,
 * web (github.com) and API (api.github.com) alike, so an integration pointed at
 * this origin speaks to it exactly as to GitHub. It models a GitHub App with
 * "Request user authorization (OAuth) during installation" on: installing
 * redirects once, to the App's Callback URL, with the installing user's OAuth
 * code.
 *
 *   GET  /apps/<slug>/installations/new   ?state&installation_id[&login][&request=1]: the install
 *                                         page's stand-in → Callback URL ?code&installation_id
 *                                         &setup_action=install&state (the code is `login`'s,
 *                                         default the installation's first user); `request=1`
 *                                         (a member asking an owner) → ?setup_action=request&state
 *   GET  /login/oauth/authorize           ?client_id&redirect_uri&state[&login][&email][&emails=none]
 *                                         → a code at once (Sign in with GitHub, and the connect's
 *                                         authorize); `prompt=select_account` with no login: the
 *                                         account picker; `emails=none`: the user authorized before
 *                                         the App asked for "Email addresses" and never approved it
 *   POST /login/oauth/access_token        client_id, client_secret, code, redirect_uri (required when the
 *                                         authorize request named one) (query or
 *                                         form) → an expiring user token and its refresh token (as
 *                                         an App with "expire user authorization tokens" on);
 *                                         grant_type=refresh_token → a new pair; a refusal is HTTP
 *                                         200 `{ error }`
 *   GET  /user                            the user token's user
 *   GET  /user/emails                     its one address, primary and verified (`email`, default
 *                                         `<login>@users.petshop.test`); for an `emails=none` token
 *                                         GitHub's 403 "Resource not accessible by integration" with
 *                                         `X-Accepted-GitHub-Permissions: emails=read`
 *   GET  /user/installations              the installations that user reaches through that client
 *   GET  /user/memberships/orgs/<org>     the user's role in an organization an installation is on
 *   POST /app/installations/<id>/access_tokens   an RS256 App JWT → an installation token
 *   GET  /installation/repositories       the repositories an installation token reaches
 *   GET  /repos/<o>/<r>/pulls/<n>/files   a seeded pull request's files (installation token)
 *   POST /repos/<o>/<r>/check-runs        a check run, kept (installation token)
 *   GET  /repos/<o>/<r>/commits/<sha>/check-runs[?check_name]   the check runs on a commit
 *
 * An installation is registered with `POST /__backdoor/apps` (state.ts `registerApp`). The OAuth
 * steps are the fakes' one authorization server (authorization-server.ts).
 */
import { z } from "zod";
import {
  fakeAuthorizationServer,
  openAccessToken,
  redirectTo,
  sealAccessToken,
  tokenClient,
} from "./authorization-server.ts";
import { verifyAppJwt } from "./github-app.ts";
import { accountPicker } from "./oidc.ts";
import { hmacSha256Hex, nowSeconds } from "./seal.ts";
import { DEFAULT_INSTALLATION_ID, fakeUserIdOf, type ShopDeps } from "./state.ts";

/** Installation tokens are short (60 s) so an integration that caches one exercises re-minting. */
export const INSTALLATION_TOKEN_TTL_SECONDS = 60;

/** The `t` of an installation token: a bearer on the installation API and on the pet shop's own
 *  API (worker.ts), bound to the App's revocation epoch. */
export const INSTALLATION_TOKEN = "github-installation";

/** What an installation token names. */
export interface InstallationGrant {
  installationId: string;
  appId: string;
}

interface GithubUserGrant {
  login: string;
  email?: string;
  /** The user never approved the App's "Email addresses" account permission. */
  emailsDenied?: true;
}

/** How long a user token lives: GitHub's eight hours. */
const USER_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** GitHub's paths on this origin, or null when the request is not one of them. */
export async function handleGithubRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const query = Object.fromEntries(url.searchParams);
  const bearer =
    /^(?:Bearer|token)\s+(\S+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
  const github = fakeAuthorizationServer<GithubUserGrant>(deps, "github");

  const install = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
  if (request.method === "GET" && install) {
    const app = (await deps.state.getState()).apps[query.installation_id || ""];
    if (!app?.callbackUrl || app.appSlug !== decodeURIComponent(install[1]!))
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (query.request === "1")
      return redirectTo(app.callbackUrl, { setup_action: "request", state: query.state });
    const code = await github.code({
      clientId: app.oauthClientId || "",
      grant: { login: query.login || app.users?.[0]?.login || "petshop-user" },
    });
    return redirectTo(app.callbackUrl, {
      code,
      installation_id: app.installationId,
      setup_action: "install",
      state: query.state,
    });
  }
  if (key === "GET /login/oauth/authorize") {
    const refusal = await github.authorizeRefusal(query.client_id || "", query.redirect_uri || "");
    if (refusal) return refusal;
    if (query.prompt === "select_account" && !query.login)
      return accountPicker(url, ["login", "email"]);
    const code = await github.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      grant: {
        login: query.login || "petshop-user",
        email: query.email,
        emailsDenied: query.emails === "none" || undefined,
      },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  if (key === "POST /login/oauth/access_token") {
    const params = { ...query, ...Object.fromEntries(new URLSearchParams(await request.text())) };
    const client = await tokenClient(deps, request, params);
    // GitHub answers a refused exchange with HTTP 200 and an `error`
    if (!client || client.client.public)
      return Response.json({ error: "incorrect_client_credentials" });
    let user: GithubUserGrant;
    if (params.grant_type === "refresh_token") {
      const refresh = await github.openRefreshToken(params.refresh_token || "", client.clientId);
      if (!refresh) return Response.json({ error: "bad_refresh_token" });
      user = refresh.grant;
    } else {
      const redeemed = await github.redeemCode(params.code || "", {
        ...client,
        redirectUri: params.redirect_uri,
        codeVerifier: params.code_verifier,
      });
      if ("refused" in redeemed)
        return Response.json({
          error:
            redeemed.refused === "redirect_uri mismatch"
              ? "redirect_uri_mismatch"
              : "bad_verification_code",
        });
      user = redeemed.grant;
    }
    return Response.json({
      access_token: await github.accessToken(client.clientId, user, USER_TOKEN_TTL_SECONDS),
      expires_in: USER_TOKEN_TTL_SECONDS,
      refresh_token: await github.refreshToken(client.clientId, user),
      token_type: "bearer",
    });
  }
  const mint = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(url.pathname);
  if (request.method === "POST" && mint) {
    const installationId = decodeURIComponent(mint[1]!);
    const app = (await deps.state.getState()).apps[installationId];
    if (!app?.publicKeyPem)
      return Response.json(
        {
          error: "invalid_installation",
          error_description: `unknown or keyless installation ${JSON.stringify(installationId)}`,
        },
        { status: 401 },
      );
    const verification = await verifyAppJwt({
      jwt: bearer,
      publicKeyPem: app.publicKeyPem,
      expectedAppId: app.appId,
      now: nowSeconds(),
    });
    if (!verification.ok)
      return Response.json(
        { error: "invalid_jwt", error_description: verification.reason },
        { status: 401 },
      );
    // sealed after the JWT is verified: the App's tokens expired meanwhile stay expired
    const token = await sealAccessToken<InstallationGrant>(
      deps,
      INSTALLATION_TOKEN,
      app.appId,
      { installationId, appId: app.appId },
      INSTALLATION_TOKEN_TTL_SECONDS,
    );
    const expiresAt = new Date((nowSeconds() + INSTALLATION_TOKEN_TTL_SECONDS) * 1000);
    return Response.json({ token, expires_at: expiresAt.toISOString() }, { status: 201 });
  }
  const badCredentials = () => Response.json({ message: "Bad credentials" }, { status: 401 });
  // A repository's pull request files and check runs, for an installation token of an
  // installation on the repository's owner (the AI linter's reads and its verdict).
  const repository =
    /^\/repos\/([^/]+)\/([^/]+)\/(pulls\/(\d+)\/files|check-runs|commits\/([^/]+)\/check-runs)$/.exec(
      url.pathname,
    );
  if (repository || key === "GET /installation/repositories") {
    const token = await openAccessToken<InstallationGrant>(deps, INSTALLATION_TOKEN, bearer);
    const state = await deps.state.getState();
    const app = token && state.apps[token.grant.installationId];
    // a repository's routes answer only an installation on its owner
    if (!token || !app || (repository && repository[1] !== app.account?.login))
      return badCredentials();
    const owner = app.account?.login || "petshop-org";
    const { installationId } = token.grant;
    if (!repository)
      return Response.json({
        total_count: 1,
        repositories: [
          { id: 1, name: "pets", full_name: `${owner}/pets`, owner: { login: owner } },
        ],
      });
    const [, , repo, route, number, ref] = repository;
    if (request.method === "GET" && number) {
      const pull = (state.githubPulls?.[installationId] || []).find(
        (known) => known.owner === owner && known.repo === repo && known.number === Number(number),
      );
      return pull
        ? Response.json(pull.files)
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (request.method === "POST" && route === "check-runs") {
      const input = (await request.json()) as Record<string, unknown>;
      const run = await deps.state.recordGithubCheckRun(installationId, {
        owner,
        repo: repo!,
        name: String(input.name || ""),
        head_sha: String(input.head_sha || ""),
        status: String(input.status || "queued"),
        conclusion: typeof input.conclusion === "string" ? input.conclusion : null,
        external_id: typeof input.external_id === "string" ? input.external_id : null,
        output: input.output ?? null,
      });
      return Response.json(run, { status: 201 });
    }
    if (request.method === "GET" && ref) {
      const name = query.check_name;
      const runs = (state.githubCheckRuns?.[installationId] || []).filter(
        (run) =>
          run.owner === owner &&
          run.repo === repo &&
          run.head_sha === ref &&
          (!name || run.name === name),
      );
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
  if (
    key !== "GET /user" &&
    key !== "GET /user/emails" &&
    key !== "GET /user/installations" &&
    !(request.method === "GET" && membership)
  )
    return null;
  const token = await github.openAccessToken(bearer);
  if (!token) return badCredentials();
  const user = token.grant;
  if (key === "GET /user")
    return Response.json({ login: user.login, id: fakeUserIdOf(user.login), type: "User" });
  if (key === "GET /user/emails" && user.emailsDenied)
    return Response.json(
      {
        message: "Resource not accessible by integration",
        documentation_url:
          "https://docs.github.com/rest/users/emails#list-email-addresses-for-the-authenticated-user",
        status: "403",
      },
      { status: 403, headers: { "x-accepted-github-permissions": "emails=read" } },
    );
  if (key === "GET /user/emails")
    return Response.json([
      {
        email: user.email || `${user.login}@users.petshop.test`,
        primary: true,
        verified: true,
        visibility: "private",
      },
    ]);
  const apps = Object.values((await deps.state.getState()).apps);
  if (membership) {
    const org = decodeURIComponent(membership[1]!);
    const member = apps
      .filter((app) => app.account?.type === "Organization" && app.account.login === org)
      .flatMap((app) => app.users || [])
      .find((candidate) => candidate.login === user.login);
    if (!member) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ state: "active", role: member.role, organization: { login: org } });
  }
  const reachable = apps.filter(
    (app) =>
      app.oauthClientId === token.clientId &&
      app.users?.some((candidate) => candidate.login === user.login),
  );
  return Response.json({
    total_count: reachable.length,
    installations: reachable.map((app) => ({
      // GitHub's ids are numbers; a registered id that is not all digits stays a string
      id: /^\d+$/.test(app.installationId) ? Number(app.installationId) : app.installationId,
      app_id: app.appId,
      app_slug: app.appSlug,
      account: app.account,
      repository_selection: "all",
    })),
  });
}

/**
 * The GitHub fake's test controls, or null:
 *   POST /__backdoor/apps                 `registerApp`'s input → register or replace an
 *                                         installation (its App's PUBLIC key; the private key
 *                                         stays with the caller)
 *   POST /__backdoor/apps/fire-webhook    { installationId?, url, event?, badSignature?,
 *                                         deliveryId?, eventName? } → POST `event` to `url` as
 *                                         GitHub delivers a webhook: signed x-hub-signature-256
 *                                         with the installation's webhook secret, named by
 *                                         x-github-delivery and x-github-event
 *   POST /__backdoor/github/pulls         seed a pull request an installation reaches
 *   GET  /__backdoor/github/check-runs?installation=   the check runs it was sent
 */
export async function handleGithubTestControls(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const body = () => request.json().catch(() => null);
  const invalid = (error_description: string) =>
    Response.json({ error: "invalid_request", error_description }, { status: 400 });
  if (key === "POST /__backdoor/apps") {
    const input = RegisterApp.safeParse(await body());
    if (!input.success) return invalid(`registerApp's input: ${input.error.message}`);
    return Response.json(await deps.state.registerApp(input.data), { status: 201 });
  }
  if (key === "POST /__backdoor/apps/fire-webhook") {
    const parsed = FireWebhook.safeParse(await body());
    const installationId = parsed.data?.installationId || DEFAULT_INSTALLATION_ID;
    const app = (await deps.state.getState()).apps[installationId];
    if (!parsed.success || !app)
      return invalid("a registered installationId and an absolute url are required");
    const input = parsed.data;
    const payload = JSON.stringify(
      input.event ?? {
        event: "installation.ping",
        installationId,
        firedAt: new Date().toISOString(),
      },
    );
    const secret = input.badSignature ? "definitely-not-the-webhook-secret" : app.webhookSecret;
    const signature = `sha256=${await hmacSha256Hex(secret, payload)}`;
    const deliveryId = input.deliveryId || crypto.randomUUID();
    const delivered = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": deliveryId,
        "x-github-event": input.eventName || "ping",
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    }).then(
      async (response) => {
        // the receiver's answer: its JSON, or its text when it is not JSON
        const text = await response.text().catch(() => "");
        return { status: response.status, body: parsedOrText(text) };
      },
      // status 0: the POST itself failed, and why
      (cause: unknown) => ({
        status: 0,
        error: cause instanceof Error ? String(cause.cause ?? cause) : String(cause),
      }),
    );
    return Response.json({
      installationId,
      deliveryId,
      url: input.url,
      signature,
      payload,
      ...delivered,
    });
  }
  if (key === "GET /__backdoor/github/check-runs") {
    const installation = url.searchParams.get("installation") || "";
    return Response.json({
      check_runs: (await deps.state.getState()).githubCheckRuns?.[installation] || [],
    });
  }
  if (key !== "POST /__backdoor/github/pulls") return null;
  const input = SeedPull.safeParse(await body());
  if (!input.success) return invalid(`a pull request: ${input.error.message}`);
  const { installationId, ...pull } = input.data;
  await deps.state.recordGithubPull(installationId, pull);
  return Response.json({ ok: true });
}

const RegisterApp = z.object({
  publicKeyPem: z.string().min(1),
  appId: z.string().optional(),
  installationId: z.string().optional(),
  webhookSecret: z.string().optional(),
  appSlug: z.string().optional(),
  callbackUrl: z.url().optional(),
  account: z
    .object({
      login: z.string(),
      id: z.number().optional(),
      type: z.enum(["Organization", "User"]).optional(),
    })
    .optional(),
  users: z.array(z.object({ login: z.string(), role: z.enum(["admin", "member"]) })).optional(),
  oauthClientId: z.string().optional(),
});

const FireWebhook = z.object({
  installationId: z.string().optional(),
  url: z.url(),
  event: z.unknown().optional(),
  badSignature: z.boolean().optional(),
  deliveryId: z.string().optional(),
  eventName: z.string().optional(),
});

const SeedPull = z.object({
  installationId: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  headSha: z.string(),
  files: z.array(z.object({ filename: z.string(), status: z.string(), patch: z.string() })),
});

function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
