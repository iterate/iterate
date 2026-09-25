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
 *   GET  /login/oauth/authorize           ?client_id&redirect_uri&state[&login][&email] → a code at
 *                                         once (Sign in with GitHub, and the connect's authorize);
 *                                         `prompt=select_account` with no login: the account picker
 *   POST /login/oauth/access_token        client_id, client_secret, code, redirect_uri (required when the
 *                                         authorize request named one) (query or
 *                                         form) → an expiring user token and its refresh token (as
 *                                         an App with "expire user authorization tokens" on);
 *                                         grant_type=refresh_token → a new pair; a refusal is HTTP
 *                                         200 `{ error }`
 *   GET  /user                            the user token's user
 *   GET  /user/emails                     its one address, primary and verified (`email`, default
 *                                         `<login>@users.petshop.test`)
 *   GET  /user/installations              the installations that user reaches through that client
 *   GET  /user/memberships/orgs/<org>     the user's role in an organization an installation is on
 *   POST /app/installations/<id>/access_tokens   an RS256 App JWT → an installation token
 *   GET  /installation/repositories       the repositories an installation token reaches
 *   GET  /repos/<o>/<r>/pulls/<n>/files   a seeded pull request's files (installation token)
 *   POST /repos/<o>/<r>/check-runs        a check run, kept (installation token)
 *   GET  /repos/<o>/<r>/commits/<sha>/check-runs[?check_name]   the check runs on a commit
 *
 * An installation is registered with `registerApp` (state.ts; the shop's
 * `POST /__backdoor/apps`). Codes and tokens are sealed blobs (seal.ts).
 */
import { verifyAppJwt } from "./github-app.ts";
import { accountPicker } from "./oidc.ts";
import { nowSeconds, seal, unseal } from "./seal.ts";
import {
  accessTokenEpochFor,
  fakeUserIdOf,
  type GithubPull,
  type IntegrationFakeDeps,
} from "./state.ts";

/** Installation tokens are short (60 s) so an integration that caches one exercises re-minting. */
export const INSTALLATION_TOKEN_TTL_SECONDS = 60;

/** An installation token: a bearer on the installation API and, like an OAuth access token, on the
 *  pet shop's own API (worker.ts), bound to the App's revocation epoch. */
export interface GithubInstallationTokenPayload {
  t: "installation";
  sub: string;
  clientId: string;
  installationId: string;
  appId: string;
  epoch: number;
  exp: number;
}

interface GithubUserCodePayload {
  t: "github-user-code";
  jti: string;
  clientId: string;
  redirectUri: string;
  /** The authorize request named `redirect_uri`, so the exchange must repeat it (RFC 6749 4.1.3);
   *  an install redirect's code went to the App's Callback URL unnamed. */
  redirectUriNamed?: true;
  login: string;
  email?: string;
  exp: number;
}

interface GithubUserTokenPayload {
  t: "github-user";
  login: string;
  email?: string;
  clientId: string;
  /** The client's revocation epoch, so `/__backdoor/expire-tokens` forces a refresh. */
  epoch?: number;
  exp: number;
}

interface GithubRefreshTokenPayload {
  t: "github-refresh";
  login: string;
  email?: string;
  clientId: string;
}

/** How long a user token lives: GitHub's eight hours. */
const USER_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** GitHub's paths on this origin, or null when the request is not one of them. */
export async function handleGithubRequest(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const query = Object.fromEntries(url.searchParams);
  const bearer = /^(?:Bearer|token)\s+(\S+)$/i.exec(
    request.headers.get("authorization") || "",
  )?.[1];
  const sealUserCode = (
    clientId: string,
    redirectUri: string,
    login: string,
    email?: string,
    redirectUriNamed?: true,
  ) =>
    seal(
      {
        t: "github-user-code",
        jti: crypto.randomUUID(),
        clientId,
        redirectUri,
        redirectUriNamed,
        login,
        email,
        exp: nowSeconds() + 600,
      } satisfies GithubUserCodePayload,
      deps.sealKey,
    );

  const install = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
  if (request.method === "GET" && install) {
    const app = (await deps.state.getState()).apps[query.installation_id || ""];
    if (!app?.callbackUrl || app.appSlug !== decodeURIComponent(install[1]!))
      return Response.json({ message: "Not Found" }, { status: 404 });
    const target = new URL(app.callbackUrl);
    if (query.request === "1") target.searchParams.set("setup_action", "request");
    else {
      const login = query.login || app.users?.[0]?.login || "petshop-user";
      target.searchParams.set(
        "code",
        await sealUserCode(app.oauthClientId || "", app.callbackUrl, login),
      );
      target.searchParams.set("installation_id", app.installationId);
      target.searchParams.set("setup_action", "install");
    }
    target.searchParams.set("state", query.state || "");
    return Response.redirect(target.toString(), 302);
  }
  if (key === "GET /login/oauth/authorize") {
    if (!(await deps.state.getState()).clients[query.client_id || ""])
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (!URL.canParse(query.redirect_uri || ""))
      return Response.json({ message: "redirect_uri is not an absolute URL" }, { status: 400 });
    if (query.prompt === "select_account" && !query.login)
      return accountPicker(url, ["login", "email"]);
    const target = new URL(query.redirect_uri!);
    target.searchParams.set(
      "code",
      await sealUserCode(
        query.client_id!,
        query.redirect_uri!,
        query.login || "petshop-user",
        query.email,
        true,
      ),
    );
    target.searchParams.set("state", query.state || "");
    return Response.redirect(target.toString(), 302);
  }
  if (key === "POST /login/oauth/access_token") {
    const params = { ...query, ...Object.fromEntries(new URLSearchParams(await request.text())) };
    const client = (await deps.state.getState()).clients[params.client_id || ""];
    // GitHub answers a refused exchange with HTTP 200 and an `error`
    if (!client || client.public || client.clientSecret !== params.client_secret)
      return Response.json({ error: "incorrect_client_credentials" });
    let user: { login: string; email?: string };
    if (params.grant_type === "refresh_token") {
      const refresh = await unseal<GithubRefreshTokenPayload>(
        params.refresh_token || "",
        deps.sealKey,
      );
      if (refresh?.t !== "github-refresh" || refresh.clientId !== params.client_id)
        return Response.json({ error: "bad_refresh_token" });
      user = refresh;
    } else {
      const code = await unseal<GithubUserCodePayload>(params.code || "", deps.sealKey);
      if (
        code?.t !== "github-user-code" ||
        code.clientId !== params.client_id ||
        code.exp <= nowSeconds() ||
        !(await deps.state.consumeAuthorizationCode(code.jti))
      )
        return Response.json({ error: "bad_verification_code" });
      if (
        (code.redirectUriNamed || params.redirect_uri) &&
        params.redirect_uri !== code.redirectUri
      )
        return Response.json({ error: "redirect_uri_mismatch" });
      user = code;
    }
    const clientId = params.client_id!;
    const token: GithubUserTokenPayload = {
      t: "github-user",
      login: user.login,
      email: user.email,
      clientId,
      epoch: accessTokenEpochFor(await deps.state.getState(), clientId),
      exp: nowSeconds() + USER_TOKEN_TTL_SECONDS,
    };
    const refresh: GithubRefreshTokenPayload = {
      t: "github-refresh",
      login: user.login,
      email: user.email,
      clientId,
    };
    return Response.json({
      access_token: await seal(token, deps.sealKey),
      expires_in: USER_TOKEN_TTL_SECONDS,
      refresh_token: await seal(refresh, deps.sealKey),
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
      jwt: bearer || "",
      publicKeyPem: app.publicKeyPem,
      expectedAppId: app.appId,
      now: nowSeconds(),
    });
    if (!verification.ok)
      return Response.json(
        { error: "invalid_jwt", error_description: verification.reason },
        { status: 401 },
      );
    const token: GithubInstallationTokenPayload = {
      t: "installation",
      sub: `installation:${installationId}`,
      clientId: app.appId,
      installationId,
      appId: app.appId,
      // read at seal time: the App's tokens expired while the JWT was verified stay expired
      epoch: accessTokenEpochFor(await deps.state.getState(), app.appId),
      exp: nowSeconds() + INSTALLATION_TOKEN_TTL_SECONDS,
    };
    return Response.json(
      {
        token: await seal(token, deps.sealKey),
        expires_at: new Date(token.exp * 1000).toISOString(),
      },
      { status: 201 },
    );
  }
  const badCredentials = () => Response.json({ message: "Bad credentials" }, { status: 401 });
  // A repository's pull request files and check runs, for an installation token of an
  // installation on the repository's owner (the AI linter's reads and its verdict).
  const repository =
    /^\/repos\/([^/]+)\/([^/]+)\/(pulls\/(\d+)\/files|check-runs|commits\/([^/]+)\/check-runs)$/.exec(
      url.pathname,
    );
  if (repository) {
    const token = await unseal<GithubInstallationTokenPayload>(bearer || "", deps.sealKey);
    const state = await deps.state.getState();
    const app = token && state.apps[token.installationId];
    const [, owner, repo, route, number, ref] = repository;
    if (
      token?.t !== "installation" ||
      token.exp <= nowSeconds() ||
      token.epoch !== accessTokenEpochFor(state, token.clientId) ||
      app?.account?.login !== owner
    )
      return badCredentials();
    if (request.method === "GET" && number) {
      const pull = (state.githubPulls?.[token.installationId] || []).find(
        (known) => known.owner === owner && known.repo === repo && known.number === Number(number),
      );
      return pull
        ? Response.json(pull.files)
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (request.method === "POST" && route === "check-runs") {
      const input = (await request.json()) as Record<string, unknown>;
      const run = await deps.state.recordGithubCheckRun(token.installationId, {
        owner: owner!,
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
      const runs = (state.githubCheckRuns?.[token.installationId] || []).filter(
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
  if (request.method !== "GET") return null;
  if (key === "GET /installation/repositories") {
    const token = await unseal<GithubInstallationTokenPayload>(bearer || "", deps.sealKey);
    const state = await deps.state.getState();
    const app = token && state.apps[token.installationId];
    if (
      token?.t !== "installation" ||
      token.exp <= nowSeconds() ||
      !app ||
      token.epoch !== accessTokenEpochFor(state, token.clientId)
    )
      return badCredentials();
    const owner = app.account?.login || "petshop-org";
    return Response.json({
      total_count: 1,
      repositories: [{ id: 1, name: "pets", full_name: `${owner}/pets`, owner: { login: owner } }],
    });
  }
  const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
  if (
    key !== "GET /user" &&
    key !== "GET /user/emails" &&
    key !== "GET /user/installations" &&
    !membership
  )
    return null;
  const token = await unseal<GithubUserTokenPayload>(bearer || "", deps.sealKey);
  if (
    token?.t !== "github-user" ||
    token.exp <= nowSeconds() ||
    (token.epoch ?? 0) !== accessTokenEpochFor(await deps.state.getState(), token.clientId)
  )
    return badCredentials();
  if (key === "GET /user")
    return Response.json({ login: token.login, id: fakeUserIdOf(token.login), type: "User" });
  if (key === "GET /user/emails")
    return Response.json([
      {
        email: token.email || `${token.login}@users.petshop.test`,
        primary: true,
        verified: true,
        visibility: "private",
      },
    ]);
  const apps = Object.values((await deps.state.getState()).apps);
  if (membership) {
    const org = decodeURIComponent(membership[1]!);
    const user = apps
      .filter((app) => app.account?.type === "Organization" && app.account.login === org)
      .flatMap((app) => app.users || [])
      .find((user) => user.login === token.login);
    if (!user) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ state: "active", role: user.role, organization: { login: org } });
  }
  const reachable = apps.filter(
    (app) =>
      app.oauthClientId === token.clientId && app.users?.some((user) => user.login === token.login),
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

/** The GitHub fake's test controls: seed a pull request an installation reaches
 *  (`POST /__backdoor/github/pulls { installationId, owner, repo, number, headSha, files }`), and
 *  read the check runs it was sent (`GET /__backdoor/github/check-runs?installation=`). */
export async function handleGithubTestControls(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /__backdoor/github/check-runs") {
    const installation = url.searchParams.get("installation") || "";
    return Response.json({
      check_runs: (await deps.state.getState()).githubCheckRuns?.[installation] || [],
    });
  }
  if (key !== "POST /__backdoor/github/pulls") return null;
  const { installationId, ...pull } = (await request.json()) as GithubPull & {
    installationId: string;
  };
  await deps.state.recordGithubPull(installationId, pull);
  return Response.json({ ok: true });
}
