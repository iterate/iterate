import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { appSession } from "iterate/app-server";
import { platformAddressesOf } from "../src/app-config.ts";
import { browserAuthorization } from "../src/browser-client.ts";
import { projectsForClient } from "../src/consent.ts";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { accountStateOf, authorizationForToken, recordGrantUse } from "../src/oauth.ts";
import type { Env } from "../src/env.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  actingAs,
  authorizationRequest,
  call,
  endGrantOnAccount,
  fetchReachesThisWorker,
  grant,
  helpers,
  issuerApprover,
  removeMembership,
  restoreMembership,
  rpc,
} from "./oauth-support.ts";
import { controlPlane, controlPlaneStub, loginPassword, ORIGIN, until } from "./support.ts";
const adminSecret = env.APP_CONFIG_SECRETS__ADMIN_BEARER!;

test("discovery advertises CIMD AND DCR: the registration endpoint is published and registers a client", async () => {
  fetchReachesThisWorker();
  // CIMD is the apps' own path (iterate/app-server.ts), but standard MCP clients (the MCP Inspector,
  // Claude's connector) require dynamic registration — so both are advertised, on every deployment.
  const metadata = await (
    await call("/.well-known/oauth-authorization-server")
  ).json<Record<string, unknown>>();
  expect(metadata).toMatchObject({
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    code_challenge_methods_supported: ["S256"],
    authorization_endpoint: `${ORIGIN}/oauth2/auth`,
    token_endpoint: `${ORIGIN}/oauth2/token`,
    registration_endpoint: `${ORIGIN}/oauth2/register`,
  });
  const registered = await call("/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "an MCP client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered).toMatchObject({ status: 201 });
  expect((await registered.json<{ client_id?: string }>()).client_id).toBeTruthy();
  // the authorization server declares its two resources (RFC 9728 `protected_resources`), and each
  // publishes its own metadata naming the issuer and the one scope a client asks for first
  expect(metadata).toMatchObject({
    issuer: ORIGIN,
    protected_resources: [`${ORIGIN}/api`, `${ORIGIN}/mcp`],
    scopes_supported: ["iterate", "account", "organizations:write", "admin"],
  });
  for (const protocol of ["api", "mcp"]) {
    expect(
      await (await call(`/.well-known/oauth-protected-resource/${protocol}`)).json(),
    ).toMatchObject({
      resource: `${ORIGIN}/${protocol}`,
      authorization_servers: [ORIGIN],
      scopes_supported: ["iterate"],
    });
    const challenge = await call(`/${protocol}`);
    expect(challenge).toMatchObject({ status: 401 });
    expect(challenge.headers.get("WWW-Authenticate")).toContain('scope="iterate"');
  }
});

test("the operator bearer is the administrator at /api and is refused at /mcp; the global namespace is no project at either", async () => {
  fetchReachesThisWorker();
  const { root } = await rpc(adminSecret);
  expect(await root.whoami()).toEqual({ actor: "admin" });
  // /mcp: every caller is a person (an OAuth grant for /mcp, or a personal access token); the
  // deployment's machine credential is refused there, and the refusal says so
  const warns = vi.spyOn(console, "warn");
  onTestFinished(() => {
    warns.mockRestore();
  });
  expect(
    await tool(adminSecret, "run", {
      project: "admin-probe",
      script: "async (itx) => itx.whoami()",
    }),
  ).toMatchObject({ status: 401 });
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.refusal",
    category: "protected-resource",
    reason: "operator_bearer_not_accepted",
    resource: `${ORIGIN}/mcp`,
  });
  warns.mockRestore();
  // the global namespace is no project, even for the admin secret — nor at /mcp for a person
  await expect(root.projects.get("global")).rejects.toThrow(/deployment-global namespace/);
  const mcpToken = (await grant([`${ORIGIN}/mcp`])).token!.access_token;
  const global = await tool(mcpToken, "run", {
    project: "global",
    script: "async (itx) => itx.whoami()",
  });
  expect(global.body.result).toMatchObject({ isError: true });
  expect(global.body.result.content[0]).toMatchObject({
    text: 'FORBIDDEN: project "global": the deployment-global namespace is no project',
  });
  // nor is a global owner subtree's resource id: it would share that user's kv and secrets
  await expect(root.projects.get("global--users--u1")).rejects.toThrow(
    /global namespace's resource prefix/,
  );
  const owner = await tool(mcpToken, "run", {
    project: "global--users--u1",
    script: "async (itx) => itx.whoami()",
  });
  expect(owner.body.result).toMatchObject({ isError: true });
  expect(owner.body.result.content[0].text).toMatch(/global namespace's resource prefix/);
  expect(await call("/api", { headers: { Authorization: "Bearer wrong" } })).toMatchObject({
    status: 401,
  });
  expect(await tool("wrong", "run", { project: "x", script: "async () => 1" })).toMatchObject({
    status: 401,
  });
  // a bearer too long to be a token is refused unread: the library's lookup key would pass KV's
  // 512-byte limit, and KV throws (a stranger's 503)
  const long = `user_${"x".repeat(600)}:grant:secret`;
  expect(await call("/api", { headers: { Authorization: `Bearer ${long}` } })).toMatchObject({
    status: 401,
  });
  expect(await tool(long, "run", { project: "x", script: "async () => 1" })).toMatchObject({
    status: 401,
  });
});

test("a grant is bound to the one resource it asked for: its token opens that alone, within membership and its project ceiling", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  expect(flow.token).toBeDefined();
  const token = flow.token!.access_token;
  const mcpToken = (await grant([`${ORIGIN}/mcp`])).token!.access_token;
  // an /api token is no /mcp token, nor the reverse (RFC 8707: one audience per token), and the
  // refusal is logged with the check that failed
  const warns = vi.spyOn(console, "warn");
  onTestFinished(() => {
    warns.mockRestore();
  });
  expect(await tool(token, "run", { script: "async () => 1" })).toMatchObject({ status: 401 });
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.refusal",
    category: "protected-resource",
    reason: "audience_mismatch",
    resource: `${ORIGIN}/mcp`,
  });
  expect(
    await call("/api", {
      method: "POST",
      body: "",
      headers: { Authorization: `Bearer ${mcpToken}` },
    }),
  ).toMatchObject({ status: 401 });
  const { root } = await rpc(token);
  expect(await root.whoami()).toEqual({ actor: flow.user.id, email: flow.user.email });
  expect(
    (await root.projects.list()).map((p: { id: string; slug: string }) => [p.id, p.slug]),
  ).toEqual([[flow.oauthA.id, "oauth-a"]]);
  await expect(root.projects.get(flow.oauthB.id)).rejects.toThrow(/outside/);
  // the slug names the project too (a URL's /projects/<slug>): the directory resolves it to the id
  using bySlug = await root.projects.get("oauth-a");
  expect(await bySlug.whoami()).toMatchObject({ projectId: flow.oauthA.id });
  expect(await tool(mcpToken, "run", { script: "async () => 1" })).toMatchObject({ status: 200 });
  const org = flow.oauthA.orgId;
  await removeMembership(org, flow.user.id);
  expect(await root.projects.list()).toEqual([]);
  expect(
    await tool(mcpToken, "run", {
      project: flow.oauthA.id,
      script: "async (itx) => itx.kv.get('x')",
    }),
  ).toMatchObject({ body: { result: { isError: true } } });
  await restoreMembership(org, flow.user.id);
  expect((await root.projects.list()).map((project) => project.id)).toEqual([flow.oauthA.id]);
});

test("resource narrowing, refresh and the revocation marker use the provider lifecycle", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/mcp`]);
  const token = flow.token!;
  expect(
    await call("/api", { headers: { Authorization: `Bearer ${token.access_token}` } }),
  ).toMatchObject({ status: 401 });
  const broaden = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: flow.clientId,
      resource: `${ORIGIN}/api`,
    }),
  });
  expect(broaden).toMatchObject({ status: 400 });
  const refresh = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: flow.clientId,
    }),
  });
  expect(refresh, await refresh.clone().text()).toMatchObject({ status: 200 });
  const renewed = await refresh.json<{ access_token: string; refresh_token: string }>();
  // A lost response may leave the client with the old refresh token. The provider
  // explicitly keeps that token usable until the client uses a newer one.
  expect(
    await call("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: flow.clientId,
      }),
    }),
  ).toMatchObject({ status: 200 });
  const [userId, grantId] = renewed.access_token.split(":");
  // Deliberately retain all valid KV records to prove the account's denial despite KV propagation.
  await endGrantOnAccount(userId!, grantId!);
  expect(
    await tool(renewed.access_token, "run", { project: "x", script: "async () => 1" }),
  ).toMatchObject({ status: 401 });
  expect(
    await call("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: renewed.refresh_token,
        client_id: flow.clientId,
      }),
    }),
  ).toMatchObject({ status: 400 });
});

test("login.allowedEmails: a live grant whose email the list stops naming is refused at its next admission", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/api`));
  const token = flow.token!.access_token;
  const listing = (patterns: string) =>
    ({ ...env, APP_CONFIG_LOGIN__ALLOWED_EMAILS: patterns }) as typeof env;
  expect(
    await authorizationForToken(listing("*@example.com"), token, addresses, "api"),
  ).toMatchObject({
    principal: { actor: flow.user.id },
  });
  expect(await authorizationForToken(listing("*@iterate.com"), token, addresses, "api")).toBeNull();
});

test("a use the account recorded within the hour is not recorded again by another isolate, and the grant is refused at its very next request once it ends", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const token = flow.token!.access_token;
  const [userId, grantId] = token.split(":") as [string, string];
  const bearer = { Authorization: `Bearer ${token}` };
  const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/api`));
  // the worker admits the token and records its use, off the response path
  expect(await call("/api", { method: "POST", body: "", headers: bearer })).toMatchObject({
    status: 200,
  });
  const usedAt = await until(
    "the use on the account",
    async () => (await accountStateOf(env, userId)).grantUses[grantId]?.at,
  );
  // This file's copy of oauth.ts has no memo of that use, as a fresh isolate has none: its
  // admission reads the use off the account, and records it no second time.
  const admitted = await authorizationForToken(env, token, addresses, "api");
  expect(admitted?.grant).toMatchObject({ grantId, lastUsedAt: usedAt });
  await recordGrantUse(env, admitted!.grant!);
  expect((await accountStateOf(env, userId)).grantUses).toMatchObject({
    [grantId]: { at: usedAt },
  });
  // Ended: the very next admission reads the end, here and at the worker, whatever use it recorded.
  await endGrantOnAccount(userId, grantId);
  expect(await authorizationForToken(env, token, addresses, "api")).toBeNull();
  expect(await call("/api", { method: "POST", body: "", headers: bearer })).toMatchObject({
    status: 401,
  });
});

test("the consent page's Authorize form admits the issuer session once its form has arrived: a session that ends while the form is on its way issues no code", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const client = await helpers().createClient({
    clientName: "Consent form",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  const { query } = await authorizationRequest(client.clientId, [`${ORIGIN}/api`]);
  const form = new URLSearchParams({ project: flow.oauthA.id, scope: "iterate" }).toString();
  const authorize = (body: BodyInit) =>
    call(`/oauth2/auth?${query}`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        cookie: flow.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  const approved = await authorize(form);
  expect(approved).toMatchObject({ status: 303 });
  expect(approved.headers.get("location")).toMatch(/^https:\/\/client\.test\/callback\?code=/);

  // The same form again, sent only once the worker is reading it and the session has ended since:
  // the approval reads the session no second time, so an admission made before the form arrived
  // would approve with a session that ended while the client was still sending.
  const issuerToken = await appSession(
    env.BROWSER_SESSION,
    new Request(ORIGIN, { headers: { cookie: flow.cookie } }),
  )!.bearer();
  const [userId, issuerGrantId] = issuerToken!.split(":") as [string, string];
  let reading = false;
  let send!: () => void;
  const sent = new Promise<void>((resolve) => (send = resolve));
  const slowForm = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading = true;
        await sent;
        controller.enqueue(new TextEncoder().encode(form));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const refusing = authorize(slowForm);
  await until("the worker reading the form", () => reading);
  await endGrantOnAccount(userId, issuerGrantId);
  send();
  const refused = await refusing;
  expect(refused).toMatchObject({ status: 303 });
  expect(refused.headers.get("location")).toBe(
    `/login?${new URLSearchParams({ next: `/oauth2/auth?${query}` })}`,
  );
});

test("an MCP tool call finds a project named by slug in the person's access record, with no catalog read; only a request answered with instructions reads the project list", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/mcp`]);
  const token = flow.token!.access_token;
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) => {
      const prototype = Object.getPrototypeOf(instance) as ControlPlaneDurableObject;
      return {
        project: vi.spyOn(prototype, "project"),
        accessibleTo: vi.spyOn(prototype, "accessibleTo"),
      };
    },
  );
  onTestFinished(() => {
    reads.project.mockRestore();
    reads.accessibleTo.mockRestore();
  });
  expect(
    await tool(token, "run", {
      project: "oauth-a",
      script: "async (itx) => (await itx.whoami()).projectId",
    }),
  ).toMatchObject({
    body: { result: { isError: false, structuredContent: { result: flow.oauthA.id } } },
  });
  // a member's project the grant did not select, by slug: refused as outside the grant
  const outside = await tool(token, "run", { project: "oauth-b", script: "async () => 1" });
  expect(outside).toMatchObject({ body: { result: { isError: true } } });
  expect(outside.text).toContain("outside this token's grant");
  expect(reads.project).not.toHaveBeenCalledWith("oauth-a");
  expect(reads.project).not.toHaveBeenCalledWith("oauth-b");
  // Past the five seconds the worker keeps a person's access (edge.ts): a list reads nothing, and
  // the handshake, whose answer carries the instructions, reads the person's access once.
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  reads.accessibleTo.mockClear();
  expect(await mcp(token, "tools/list", {})).toMatchObject({ status: 200 });
  expect(reads.accessibleTo).not.toHaveBeenCalled();
  const initialized = await mcp(token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "oauth-test", version: "1.0.0" },
  });
  expect(initialized).toMatchObject({
    body: {
      result: { instructions: expect.stringContaining("This token reaches one project, oauth-a") },
    },
  });
  expect(reads.accessibleTo).toHaveBeenCalledOnce();
});

test("a refresh a second after the code exchange reads the grant the exchange wrote, whatever copy KV serves", async () => {
  fetchReachesThisWorker();
  // KV serves a location's cached copy of a key for up to 60 s after another location wrote a new
  // one. CI, 2026-09-23: consent ran at IAD, the code exchange at EWR, and the CLI's refresh a second
  // later at IAD read the grant as consent wrote it, with no refresh token yet: `invalid_grant:
  // Invalid refresh token`. Every KV read here is that location's: a key's first write.
  const firstWrites = kvServesFirstWrites();
  const flow = await grant([`${ORIGIN}/api`]);
  // the model is the worker's own KV: the client registration and the access token went through it
  expect(firstWrites.size).toBeGreaterThan(0);
  const refresh = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: flow.token!.refresh_token,
      client_id: flow.clientId,
    }),
  });
  expect(refresh, await refresh.clone().text()).toMatchObject({ status: 200 });
  const renewed = await refresh.json<{ access_token: string }>();
  const admitted = await call("/api", {
    headers: { Authorization: `Bearer ${renewed.access_token}` },
  });
  expect(admitted).not.toMatchObject({ status: 401 });
});

// THE PINNED BUG the grant store works around (src/oauth-store.ts): the library's OWN grant storage,
// with no iterate store in front of it, under the same stale-KV model as the row above. Upstream it is
// cloudflare/workers-oauth-provider#214 (refresh-token rotation on eventually consistent KV), and #312
// (pluggable storage providers, a Durable Object adapter among them) proposes the fix. The exit: when
// the library ships storage with strongly consistent grants, give this server that option. It then
// passes, `createFailing` turns the row red, and src/oauth-store.ts and
// src/control-plane/oauth-grants.ts are deleted. #312 keeps KV the default, so the row cannot turn
// red by itself: the `storage` line below is the signal — the day the library has the option, the
// directive is unused and the typecheck fails, pointing here.
createFailing(
  test,
  /a refresh right after the code exchange should succeed: \{"error":"invalid_grant","error_description":"Invalid refresh token"\}/,
)(
  "the library's own grant storage refreshes right after a code exchange served at another location",
  async () => {
    kvServesFirstWrites();
    const server = new OAuthAuthorizationServer({
      issuer: ORIGIN,
      resources: [`${ORIGIN}/api`],
      authorizeEndpoint: "/oauth2/auth",
      tokenEndpoint: "/oauth2/token",
      // @ts-expect-error — no storage option yet (upstream #312): set it to the strongly consistent one
      storage: undefined,
    });
    const oauth = server.getOAuthApi(env);
    const client = await oauth.createClient({
      clientName: "Library storage",
      redirectUris: ["https://client.test/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    const { query, verifier } = await authorizationRequest(client.clientId, [`${ORIGIN}/api`]);
    const { redirectTo } = await oauth.completeAuthorization({
      request: await oauth.parseAuthRequest(new Request(`${ORIGIN}/oauth2/auth?${query}`)),
      userId: "user_library",
      scope: ["iterate"],
      metadata: {},
      props: {},
    });
    const token = (body: Record<string, string>) =>
      server.fetch(
        new Request(`${ORIGIN}/oauth2/token`, { method: "POST", body: new URLSearchParams(body) }),
        env,
        createExecutionContext(),
      );
    const exchange = await token({
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code")!,
      client_id: client.clientId,
      redirect_uri: "https://client.test/callback",
      code_verifier: verifier,
    });
    expect(exchange, await exchange.clone().text()).toMatchObject({ status: 200 });
    const refresh = await token({
      grant_type: "refresh_token",
      refresh_token: (await exchange.json<{ refresh_token: string }>()).refresh_token,
      client_id: client.clientId,
    });
    expect(
      refresh,
      `a refresh right after the code exchange should succeed: ${await refresh.clone().text()}`,
    ).toMatchObject({ status: 200 });
  },
);

test("the library writes no key but a grant twice: what the grant store leaves in KV is written once (src/oauth-store.ts)", async () => {
  fetchReachesThisWorker();
  const writes = new Map<string, number>();
  const put = env.OAUTH_KV.put.bind(env.OAUTH_KV);
  const puts = vi.spyOn(env.OAUTH_KV, "put").mockImplementation(async (key, value, options) => {
    writes.set(key, (writes.get(key) ?? 0) + 1);
    await put(key, value, options);
  });
  onTestFinished(() => {
    puts.mockRestore();
  });
  // every write the library makes: a registration, an issuer sign-in and a consent, a code
  // exchange, two refreshes and a revocation
  const registered = await call("/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "a registered MCP client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered).toMatchObject({ status: 201 });
  const flow = await grant([`${ORIGIN}/api`]);
  let refreshToken = flow.token!.refresh_token;
  for (let refreshes = 0; refreshes < 2; refreshes++) {
    const refresh = await call("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: flow.clientId,
      }),
    });
    expect(refresh, await refresh.clone().text()).toMatchObject({ status: 200 });
    refreshToken = (await refresh.json<{ refresh_token: string }>()).refresh_token;
  }
  const revoked = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({ token: refreshToken, client_id: flow.clientId }),
  });
  expect(revoked).toMatchObject({ status: 200 });
  // the sign-in's own counters (password-and-code-sign-in.ts) are the platform's, not the library's
  const library = [...writes].filter(([key]) => !key.startsWith("login-"));
  expect(library.map(([key]) => key.split(":")[0]).sort()).toEqual(
    expect.arrayContaining(["client", "token"]),
  );
  expect(library.filter(([key]) => key.startsWith("grant:"))).toEqual([]);
  expect(library.filter(([, count]) => count > 1)).toEqual([]);
});

test("an interactive grant lives a week unused: each refresh moves the week on, and its deadline caps it", async () => {
  fetchReachesThisWorker();
  const week = 7 * 24 * 3600;
  const now = () => Math.floor(Date.now() / 1000);
  const user = await controlPlane().ensureUser("idle-expiry@example.com");
  const client = await helpers().createClient({
    clientName: "Idle expiry",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  /** A consented grant whose deadline is `days` away, exchanged: its tokens and its expiry. */
  const session = async (days: number) => {
    const { query, verifier } = await authorizationRequest(client.clientId, [`${ORIGIN}/api`]);
    const deadline = Date.now() + days * 24 * 3600_000;
    const { redirectTo } = await helpers().completeAuthorization({
      request: await helpers().parseAuthRequest(new Request(`${ORIGIN}/oauth2/auth?${query}`)),
      userId: user.id,
      scope: ["iterate"],
      metadata: {},
      revokeExistingGrants: false,
      props: { kind: "app", userId: user.id, email: user.email, projects: null, deadline },
    });
    const exchange = await call("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code")!,
        client_id: client.clientId,
        redirect_uri: "https://client.test/callback",
        code_verifier: verifier,
      }),
    });
    expect(exchange, await exchange.clone().text()).toMatchObject({ status: 200 });
    const tokens = await exchange.json<{ access_token: string; refresh_token: string }>();
    const grantId = tokens.access_token.split(":")[1];
    const expiry = async () =>
      (await helpers().listUserGrants(user.id)).items.find((item) => item.id === grantId)!
        .expiresAt!;
    const refresh = async () => {
      const refreshed = await call("/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: client.clientId,
        }),
      });
      expect(refreshed, await refreshed.clone().text()).toMatchObject({ status: 200 });
      return refreshed.json<{ expires_in: number }>();
    };
    return { deadline: Math.floor(deadline / 1000), expiry, refresh };
  };
  // thirty days to its deadline: a week from the exchange, then a week from each refresh
  const month = await session(30);
  expect((await month.expiry()) - now()).toBeGreaterThan(week - 60);
  expect((await month.expiry()) - now()).toBeLessThanOrEqual(week);
  const before = await month.expiry();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await month.refresh()).toMatchObject({ expires_in: 3600 });
  expect(await month.expiry()).toBeGreaterThan(before);
  // two days to its deadline: the deadline is the expiry, at the exchange and after a refresh
  const short = await session(2);
  expect(Math.abs((await short.expiry()) - short.deadline)).toBeLessThanOrEqual(2);
  await short.refresh();
  expect(Math.abs((await short.expiry()) - short.deadline)).toBeLessThanOrEqual(2);
});

test("issuer login uses the same revocable API session and has no independent identity cookie", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  expect(flow.cookie).toMatch(/^__Host-itx-session=/);
  expect(
    await call("/api", {
      method: "POST",
      body: "",
      headers: { cookie: flow.cookie, Origin: ORIGIN },
    }),
  ).toMatchObject({ status: 200 });
  const logout = await call("/.auth/logout", {
    method: "POST",
    headers: { cookie: flow.cookie, Origin: ORIGIN },
  });
  expect(logout).toMatchObject({ status: 303 });
  const fresh = await call("/.auth/login", { headers: { cookie: flow.cookie } });
  expect(fresh).toMatchObject({ status: 303 });
  expect(fresh.headers.get("location")).toBe("/login?next=%2F");
  expect(fresh.headers.has("set-cookie")).toBe(false);
});

test("console and project browsers use the same CIMD flow and independent grants", async () => {
  let logoutUnavailable = false;
  const metadataFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!["/.auth/client.json", "/oauth2/token", "/api"].includes(url.pathname))
      throw new Error(`Unexpected external fetch: ${url}`);
    if (logoutUnavailable && url.pathname === "/api")
      return new Response("Unavailable", { status: 503 });
    return exports.default.fetch(request);
  });
  onTestFinished(() => {
    metadataFetch.mockRestore();
  });
  const issuerLogin = await call("/login", {
    method: "POST",
    body: new URLSearchParams({
      email: "browser@example.com",
      password: loginPassword(),
      next: "/",
    }),
  });
  const issuerCookie = issuerLogin.headers.get("set-cookie")!.split(";")[0]!;
  const user = await controlPlane().ensureUser("browser@example.com");
  const theirs = await actingAs(user.email);
  using _a = await theirs.projects.create({ project: "browser-a" });
  using _b = await theirs.projects.create({ project: "browser-b" });
  const browserA = (await controlPlane().getProject("browser-a"))!;
  const browserB = (await controlPlane().getProject("browser-b"))!;
  const logins = [];
  try {
    for (const origin of [ORIGIN, "https://notes--browser-a.projects.test"]) {
      const metadata = await exports.default.fetch(`${origin}/.auth/client.json`);
      expect(metadata).toMatchObject({ status: 200 });
      let cookie = issuerCookie;
      if (origin !== ORIGIN) {
        const start = await exports.default.fetch(`${origin}/.auth/login?next=/`, {
          redirect: "manual",
        });
        cookie = start.headers.get("set-cookie")!.split(";")[0]!;
        const authorize = new URL(start.headers.get("location")!);
        expect(authorize).toMatchObject({ origin: ORIGIN });
        expect(authorize.searchParams.get("client_id")).toBe(`${origin}/.auth/client.json`);
        const issuer = appSession(
          env.BROWSER_SESSION,
          new Request(ORIGIN, { headers: { cookie: issuerCookie } }),
        )!;
        const { root: approver } = await rpc((await issuer.bearer())!);
        const approve = await approver.consent.approve({
          query: authorize.search,
          projects: ["*", browserA.id, browserB.id],
        });
        if ("error" in approve) throw new Error(approve.error);
        for (const field of ["state", "iss"]) {
          const invalid = new URL(approve.redirectTo);
          invalid.searchParams.delete(field);
          const rejected = await exports.default.fetch(invalid.href, {
            redirect: "manual",
            headers: { cookie },
          });
          expect(rejected).toMatchObject({ status: 400 });
        }
        const callback = await exports.default.fetch(approve.redirectTo, {
          redirect: "manual",
          headers: { cookie },
        });
        expect(callback, await callback.clone().text()).toMatchObject({ status: 303 });
      }
      const response = await exports.default.fetch(`${origin}/api`, {
        headers: { cookie, Origin: origin, Upgrade: "websocket" },
      });
      expect(response, response.status === 101 ? "" : await response.text()).toMatchObject({
        status: 101,
      });
      response.webSocket!.accept();
      const transport = newWebSocketRpcSession<IterateRpcTarget>(
        response.webSocket! as unknown as WebSocket,
      );
      onTestFinished(() => {
        transport[Symbol.dispose]();
      });
      const root = transport.authenticate({ type: "from-server-cookie" });
      expect(await root.whoami()).toEqual({ actor: user.id, email: user.email });
      expect(
        (await root.projects.list()).map((p: { id: string; slug: string }) => [p.id, p.slug]),
      ).toEqual(
        origin === ORIGIN
          ? [
              [browserA.id, "browser-a"],
              [browserB.id, "browser-b"],
            ]
          : [[browserA.id, "browser-a"]],
      );
      // The cookie's authority is same-origin only: a cross-site request goes on BARE and meets the
      // OAuth gate's 401 (a bare WebSocket would authenticate in-band instead — e2e/session).
      expect(
        await exports.default.fetch(`${origin}/api`, {
          headers: { cookie, Origin: "https://evil.test" },
        }),
      ).toMatchObject({ status: 401 });
      logins.push({ origin, cookie, root });
    }
    const upgrade = await exports.default.fetch(
      `${logins[1]!.origin}/.auth/login?scope=iterate%20account`,
      {
        headers: { cookie: logins[1]!.cookie },
        redirect: "manual",
      },
    );
    expect(upgrade).toMatchObject({ status: 200 });
    expect(upgrade.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await upgrade.text()).toContain('method="post"');
    expect((await helpers().listUserGrants(user.id)).items).toHaveLength(2);
    const consoleLogin = logins[0]!;
    const repeatedLogin = await call("/.auth/login", { headers: { cookie: consoleLogin.cookie } });
    expect(repeatedLogin).toMatchObject({ status: 303 });
    expect(repeatedLogin.headers.get("set-cookie")).toBeNull();
    expect((await helpers().listUserGrants(user.id)).items).toHaveLength(2);
    // only the console's session holds `account`: an app's may neither list, mint nor end (the
    // personal access tokens themselves: personal-access-tokens.test.ts)
    await expect(logins[1]!.root.grants.list()).rejects.toThrow(/Account permission/);
    await expect(
      logins[1]!.root.grants.mint({ name: "Denied", projects: [browserA.id] }),
    ).rejects.toThrow(/Account permission/);
    await expect(logins[1]!.root.grants.end("foreign-grant")).rejects.toThrow(/Account permission/);
    const inventory = await consoleLogin.root.grants.list();
    expect(inventory.items.find((item) => item.current)).toMatchObject({
      kind: "session",
      resource: "api",
    });
    await expect(consoleLogin.root.grants.end("foreign-grant")).rejects.toThrow(
      /Session not found/,
    );
    // a foreign grant ends nothing: no end lands on the account
    expect((await accountStateOf(env, user.id)).endedGrants["foreign-grant"]).toBeUndefined();
    const refusals = vi.spyOn(console, "warn");
    onTestFinished(() => {
      refusals.mockRestore();
    });
    const consoleToken = await appSession(
      env.BROWSER_SESSION,
      new Request(ORIGIN, { headers: { cookie: consoleLogin.cookie } }),
    )!.bearer();
    expect(
      await call("/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: consoleToken!,
          client_id: `${ORIGIN}/.auth/client.json`,
        }),
      }),
    ).toMatchObject({ status: 400 });
    // an access token presented as a refresh token: the library refuses it before any lifetime
    // policy runs, logged as that refusal (`onError`)
    expect(refusals).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "oauth.refusal",
        status: 400,
        category: "refresh-token-grant",
        reason: "refresh_token_mismatch",
      }),
    );
    refusals.mockRestore();
    const cookieRequest = new Request(`${ORIGIN}/`, { headers: { cookie: consoleLogin.cookie } });
    const heldSession = appSession(env.BROWSER_SESSION, cookieRequest)!;
    const bearerBefore = await heldSession.bearer();
    // a validation that could not answer (its store unavailable) is no refusal: the session stays
    const providerFailure = vi
      .spyOn(OAuthAuthorizationServer.prototype, "validateToken")
      .mockRejectedValueOnce(new Error("OAUTH_KV unavailable"));
    onTestFinished(() => {
      providerFailure.mockRestore();
    });
    await expect(browserAuthorization(env, cookieRequest)).rejects.toThrow(/OAUTH_KV unavailable/);
    providerFailure.mockRestore();
    expect(await heldSession.bearer()).toBe(bearerBefore);
    logoutUnavailable = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      log.mockRestore();
    });
    const failedLogout = await call("/.auth/logout", {
      method: "POST",
      headers: { cookie: consoleLogin.cookie, Origin: ORIGIN },
    });
    expect(failedLogout).toMatchObject({ status: 503 });
    expect(failedLogout.headers.has("set-cookie")).toBe(false);
    expect(await heldSession.bearer()).toBe(bearerBefore);
    log.mockRestore();
    logoutUnavailable = false;
    const logout = await call("/.auth/logout", {
      method: "POST",
      headers: { cookie: consoleLogin.cookie, Origin: ORIGIN },
    });
    expect(logout).toMatchObject({ status: 303 });
    expect(logout.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringContaining("__Host-itx-session=;")]),
    );
    expect(
      await call("/api", { headers: { cookie: consoleLogin.cookie, Origin: ORIGIN } }),
    ).toMatchObject({ status: 401 });
    const app = logins[1]!;
    expect(
      await exports.default.fetch(`${app.origin}/api`, {
        headers: { cookie: app.cookie, Origin: app.origin, Upgrade: "websocket" },
      }),
    ).toMatchObject({ status: 101 });
  } finally {
    metadataFetch.mockRestore();
  }
});

test("malformed, foreign and several resources are expected authorization refusals", async () => {
  fetchReachesThisWorker();
  for (const resources of [
    ["not a URL"],
    ["https://foreign.test/api"],
    // one grant, one resource (RFC 8707): a request naming both is refused, never split
    [`${ORIGIN}/api`, `${ORIGIN}/mcp`],
  ])
    expect(await grant(resources)).toMatchObject({ error: "invalid_target" });
});

// THE ACCESS MEMO (control-plane/edge.ts): an isolate keeps a person's access five seconds, and a
// creation drops it only on the isolate that served the create. `exports.default` is the built
// worker with its own copy of edge.ts, so a create through this module's ControlPlane is a create
// on ANOTHER isolate: the worker's memo still holds the person without it. Consent re-reads before
// it refuses a ticked project and lists past the memo (e2e ingress-project-host: "Choose at least
// one project you can access." in 12 of 124 deployed runs, 2026-09).
test("consent lists and approves a project created on another isolate within the access memo's five seconds", async () => {
  fetchReachesThisWorker();
  const email = "consent-fresh@example.com";
  const login = await call("/login", {
    method: "POST",
    body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const user = await controlPlane().ensureUser(email);
  const caller = { principal: { actor: user.id, email } };
  await controlPlane().createProject(caller, { project: "consent-fresh-a" });
  const client = await helpers().createClient({
    clientName: "Consent freshness",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  const approver = await issuerApprover(cookie);
  const listed = async () => {
    const view = await approver.consent.describe(
      `?${(await authorizationRequest(client.clientId, [`${ORIGIN}/api`])).query}`,
    );
    if (view.kind !== "consent") throw new Error(JSON.stringify(view));
    return view.projects.map((project) => project.slug).sort();
  };
  // the worker memoizes the person's access: one project
  expect(await listed()).toEqual(["consent-fresh-a"]);
  const second = await controlPlane().createProject(caller, { project: "consent-fresh-b" });
  // ticked at once: the memoized set lacks it, so approve re-reads before refusing
  const approval = await approver.consent.approve({
    query: `?${(await authorizationRequest(client.clientId, [`${ORIGIN}/api`])).query}`,
    projects: [second.id],
  });
  expect(approval).toEqual({ redirectTo: expect.stringContaining("code=") });
  await controlPlane().createProject(caller, { project: "consent-fresh-c" });
  // the page lists what the person holds now, whatever this isolate memoized
  expect(await listed()).toEqual(["consent-fresh-a", "consent-fresh-b", "consent-fresh-c"]);
});

test("a first-level wildcard CIMD client is bound to its project at consent", async () => {
  fetchReachesThisWorker();
  const user = await controlPlane().createUser({ email: "wildcard-consent@example.com" });
  const caller = { principal: { actor: user.id, email: user.email } };
  const target = await controlPlane().createProject(caller, { project: "wildcard-consent" });
  await controlPlane().createProject(caller, { project: "other-consent" });
  const configured = {
    ...env,
    APP_CONFIG_URLS__PROJECT_WILDCARD: JSON.stringify({
      hostname: "iterate.com",
      project: "wildcard-consent",
      excludedHostnames: [
        "os.iterate.com",
        "mcp.iterate.com",
        "dash.iterate.com",
        "k.iterate.com",
        "voice.iterate.com",
        "install.iterate.com",
      ],
    }),
  } as Env;
  const bound = await projectsForClient(
    configured,
    ORIGIN,
    "https://www.iterate.com/.auth/client.json",
    user.id,
  );
  expect(bound).toMatchObject({ projectBound: true });
  expect(bound.projects.map((project) => project.id)).toEqual([target.id]);
  const issuer = await projectsForClient(
    configured,
    ORIGIN,
    `${ORIGIN}/.auth/client.json`,
    user.id,
  );
  expect(issuer).toMatchObject({ projectBound: false });
  for (const hostname of ["os", "mcp", "dash", "k", "voice", "install"]) {
    const firstParty = await projectsForClient(
      configured,
      ORIGIN,
      `https://${hostname}.iterate.com/.auth/client.json`,
      user.id,
    );
    expect(firstParty).toMatchObject({ projectBound: false });
  }
});

/** `OAUTH_KV` as a location that cached every key at its first write: each read answers that
 *  write, whatever was written since (until the test finishes). Answers the first writes by key. */
function kvServesFirstWrites(): Map<string, string> {
  const kv = env.OAUTH_KV;
  const firstWrites = new Map<string, string>();
  const put = kv.put.bind(kv);
  const get = kv.get.bind(kv) as (key: string, options?: unknown) => Promise<unknown>;
  const puts = vi.spyOn(kv, "put").mockImplementation(async (key, value, options) => {
    if (typeof value === "string" && !firstWrites.has(key)) firstWrites.set(key, value);
    await put(key, value, options);
  });
  const gets = vi.spyOn(kv, "get").mockImplementation((async (key: string, options?: unknown) => {
    const first = firstWrites.get(key);
    if (!first) return get(key, options);
    const type = typeof options === "string" ? options : (options as { type?: string })?.type;
    return type === "json" ? JSON.parse(first) : first;
  }) as never);
  onTestFinished(() => {
    puts.mockRestore();
    gets.mockRestore();
  });
  return firstWrites;
}

function tool(token: string, name: string, args: object = {}) {
  return mcp(token, "tools/call", { name, arguments: args });
}

/** One JSON-RPC request to `/mcp` with `token`, and its answer: the status, the text and, on a 200,
 *  the response message (read off the event stream when the answer is one). */
async function mcp(token: string, method: string, params: object) {
  const response = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body:
      response.status !== 200
        ? null
        : response.headers.get("content-type")?.startsWith("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
              .find((message) => message.id === 1)
          : JSON.parse(text),
  };
}
