import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget, RpcStub } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { appSession } from "iterate/next/app-server";
import { platformAddressesOf } from "../src/app-config.ts";
import type { GrantEnded } from "../src/account/contract.ts";
import { browserAuthorization } from "../src/browser-client.ts";
import { projectsForClient } from "../src/consent.ts";
import { ControlPlane } from "../src/control-plane/edge.ts";
import { accountStateOf, authorizationForToken, oauthHelpers } from "../src/oauth.ts";
import { rpcResponse } from "../src/rpc.ts";
import type { Env } from "../src/env.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { adminSession, controlPlane, loginPassword, ORIGIN, stub } from "./support.ts";
const adminSecret = env.APP_CONFIG_SECRETS__ADMIN_BEARER!;

test("discovery advertises CIMD AND DCR: the registration endpoint is published and registers a client", async () => {
  fetchReachesThisWorker();
  // CIMD is the apps' own path (iterate/next/app-server.ts), but standard MCP clients (the MCP Inspector,
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
  for (const protocol of ["api", "mcp"]) {
    expect(
      await (await call(`/.well-known/oauth-protected-resource/${protocol}`)).json(),
    ).toMatchObject({
      resource: `${ORIGIN}/${protocol}`,
      authorization_servers: [ORIGIN],
      scopes_supported:
        protocol === "mcp" ? ["iterate"] : ["iterate", "account", "organizations:write"],
    });
    const challenge = await call(`/${protocol}`);
    expect(challenge).toMatchObject({ status: 401 });
    expect(challenge.headers.get("WWW-Authenticate")).toContain('scope="iterate"');
  }
});

test("the configured header bearer is the same administrator at both protocols", async () => {
  fetchReachesThisWorker();
  const { root } = await rpc(adminSecret);
  expect(await root.whoami()).toEqual({ actor: "admin" });
  expect(
    JSON.parse(
      (
        await tool(adminSecret, "run", {
          project: "admin-probe",
          script: "async (itx) => itx.whoami()",
        })
      ).body.result.content[0].text,
    ),
  ).toEqual({ projectId: "admin-probe", path: "/" }); // MCP executes on the authorized project root.
  // the global namespace is no project, even for the admin secret — at either protocol
  await expect(root.projects.get("global")).rejects.toThrow(/deployment-global namespace/);
  const global = await tool(adminSecret, "run", {
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
  const owner = await tool(adminSecret, "run", {
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
});

test("one provider grant can cover MCP and Cap'n Web while retaining membership and its project ceiling", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`, `${ORIGIN}/mcp`]);
  expect(flow.token).toBeDefined();
  const token = flow.token!.access_token;
  const { root } = await rpc(token);
  expect(await root.whoami()).toEqual({ actor: flow.user.id, email: flow.user.email });
  expect(
    (await root.projects.list()).map((p: { id: string; slug: string }) => [p.id, p.slug]),
  ).toEqual([[flow.oauthA.id, "oauth-a"]]);
  await expect(root.projects.get(flow.oauthB.id)).rejects.toThrow(/outside/);
  // the slug names the project too (a URL's /projects/<slug>): the directory resolves it to the id
  using bySlug = await root.projects.get("oauth-a");
  expect(await bySlug.whoami()).toMatchObject({ projectId: flow.oauthA.id });
  expect(await tool(token, "run", { script: "async () => 1" })).toMatchObject({ status: 200 });
  const org = flow.oauthA.orgId;
  await removeMembership(org, flow.user.id);
  expect(await root.projects.list()).toEqual([]);
  expect(
    await tool(token, "run", {
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

test.for(["revoked", "membership"])(
  "a live session loses held capabilities after %s within 60 seconds",
  async (reason) => {
    fetchReachesThisWorker();
    const flow = await grant([`${ORIGIN}/api`]);
    const { root, closed, boundAt } = await rpc(flow.token!.access_token);
    using context = await root.projects.get(flow.oauthA.id);
    const native = (await context.invoke(
      `itx.workers.get({source: {"cap.js": "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { ping() { return 'pong'; } }"}})`,
    )) as unknown as { ping(): Promise<string> };
    expect(await native.ping()).toBe("pong");
    class Echo extends RpcTarget {
      ping() {
        return "lent";
      }
    }
    using echo = new RpcStub(new Echo());
    // The local target becomes a ClientRpcStub on the wire; its index-signature type is wider than this typed stub.
    await context.provide(
      "itx.liveAuthEcho",
      echo as unknown as Parameters<typeof context.provide>[1],
    );
    const lent = (await context.invoke("itx.liveAuthEcho")) as unknown as {
      ping(): Promise<string>;
    };
    expect(await lent.ping()).toBe("lent");
    const org = flow.oauthA.orgId;
    const [, grantId] = flow.token!.access_token.split(":");
    if (reason === "revoked") await endGrantOnAccount(flow.user.id, grantId!);
    else await removeMembership(org, flow.user.id);
    try {
      // Real elapsed time: the guard's own timer closes the socket — no sooner than 30 s after the
      // bind (less a second of timer slack), within its 60 s hard bound — and only then are the
      // stubs asserted dead, so no call races the close.
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          bound = setTimeout(
            () => reject(new Error("the guard did not close the socket within 60 s")),
            60_000,
          );
        }),
      ]).finally(() => clearTimeout(bound));
      expect(Date.now() - boundAt).toBeGreaterThanOrEqual(29_000);
      await expect(root.whoami()).rejects.toThrow(/Session|closed|RPC|revoked/i);
      await expect(context.invoke("itx.kv.get('live-auth-probe')")).rejects.toThrow(
        /Session|closed|RPC|revoked/i,
      );
      await expect(native.ping()).rejects.toThrow(/Session|closed|RPC|revoked/i);
      await expect(lent.ping()).rejects.toThrow(/Session|closed|RPC|revoked/i);
    } finally {
      if (reason === "membership") await restoreMembership(org, flow.user.id);
    }
  },
);

test("a socket holding no project re-checks its grant every thirty seconds and reads no membership", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const { root } = await rpc(flow.token!.access_token);
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id });
  // The worker under test runs in this isolate: the guard's membership read (rpc.ts —
  // `controlPlane.reachableProjects`, the one read behind every reach check) passes this spy.
  const membershipReads = vi.spyOn(ControlPlane.prototype, "reachableProjects");
  onTestFinished(() => {
    membershipReads.mockRestore();
  });
  // Real elapsed time: one tick of the deployed 30 s interval, nothing test-only.
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  membershipReads.mockRestore();
  // Every socket in this test holds no project (this one, and `grant()`'s issuer session that
  // approved the consent): each tick reads its grant on the account and no membership at all.
  expect(membershipReads).not.toHaveBeenCalled();
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id }); // still live: it holds nothing to lose
});

test("a live session rides out a deploy's Durable Object reset during its re-check", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  // THE GUARD FROM SOURCE (src/rpc.ts), not through `exports.default`: it serves the built worker, whose own
  // copy of ControlPlane a spy on the source class never sees. Same admission as /api's.
  const request = new Request(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN },
  });
  const executionContext = createExecutionContext();
  const authorization = await authorizationForToken(
    env,
    executionContext,
    flow.token!.access_token,
    platformAddressesOf(env, request),
  );
  const response = await rpcResponse(request, env, executionContext, authorization);
  expect(response).toMatchObject({ status: 101 });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  const root = transport.authenticate({ type: "from-server-cookie" });
  using context = await root.projects.get(flow.oauthA.id);
  await context.invoke("itx.kv.get('live-auth-probe')"); // holds the project: the tick reads membership
  // What a deploy does to the tick's membership read (prd, 2026-09-23 after #2888): the control
  // plane's Durable Object is reset for its new code and workerd stamps the cut call retryable.
  const membershipReads = vi
    .spyOn(ControlPlane.prototype, "reachableProjects")
    .mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("Durable Object reset because its code was updated."), {
          retryable: true,
          durableObjectReset: true,
        }),
      ),
    );
  onTestFinished(() => {
    membershipReads.mockRestore();
  });
  // Real elapsed time: the 30 s tick meets the reset, and its retry 2 s later reads through.
  await new Promise((resolve) => setTimeout(resolve, 34_000));
  const reads = membershipReads.mock.calls.length; // mockRestore clears the record
  membershipReads.mockRestore();
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id });
  await context.invoke("itx.kv.get('live-auth-probe')"); // the project it holds still answers
});

test("console and project browsers use the same CIMD flow and independent grants", async () => {
  let logoutUnavailable = false;
  const metadataFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === "https://kit.test/devices/missing.json")
      return new Response("Not found", { status: 404 });
    if (url.origin === "https://kit.test" && url.pathname.startsWith("/devices/"))
      return Response.json({
        client_id: url.href,
        client_name: "Home Assistant Voice Preview Edition",
        logo_uri: "https://kit.test/vendors/home-assistant.png",
        redirect_uris: ["https://kit.test/.auth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
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
    const personal = await consoleLogin.root.grants.mint({
      name: "My CLI",
      projects: [browserA.id],
    });
    await expect(logins[1]!.root.grants.list()).rejects.toThrow(/Account permission/);
    await expect(
      logins[1]!.root.grants.mint({ name: "Denied", projects: [browserA.id] }),
    ).rejects.toThrow(/Account permission/);
    await expect(logins[1]!.root.grants.end("foreign-grant")).rejects.toThrow(/Account permission/);
    const storedPersonal = await helpers().unwrapToken(personal.token);
    expect(storedPersonal).not.toBeNull();
    expect(storedPersonal!.expiresAt * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    // The provider rounds TTLs to seconds; the displayed deadline must agree with its actual token.
    expect(Math.abs(storedPersonal!.expiresAt * 1000 - personal.expiresAt)).toBeLessThan(2000);
    expect(
      JSON.parse(
        (await tool(personal.token, "run", { script: "async (itx) => itx.whoami()" })).body.result
          .content[0].text,
      ),
    ).toEqual({
      projectId: browserA.id,
      path: "/", // the token's own connection context, named by its grant (mcp.ts)
      projectSlug: "browser-a",
      projectUrl: "https://browser-a.projects.test/",
    });
    const { root: personalApi } = await rpc(personal.token);
    expect((await personalApi.projects.list()).map((p: { id: string }) => p.id)).toEqual([
      browserA.id,
    ]);
    // A device says `bearer` for the same act (Kit firmware, itx_mount.c): the token rode the
    // upgrade, hand me that session.
    const { root: bearerApi } = await rpc(personal.token, "bearer");
    expect((await bearerApi.projects.list()).map((p: { id: string }) => p.id)).toEqual([
      browserA.id,
    ]);
    // Bound to a project, the token opens none of the person's own: no `.user` context.
    await expect(Promise.resolve().then(() => personalApi.user.whoami())).rejects.toThrow(
      /bound to projects/,
    );
    await expect(
      consoleLogin.root.grants.mint({
        name: "Unavailable device",
        projects: [browserA.id],
        clientId: "https://kit.test/devices/missing.json",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The device's OAuth metadata could not be loaded. Try preparing the device again.",
    });
    // A device's token: `expiresAt` asks for years, capped at ten; the provider's token agrees.
    const device = await consoleLogin.root.grants.mint({
      name: "Kit HAVPE",
      clientId: "https://kit.test/devices/havpe/clients/unit-one.json",
      projects: [browserA.id],
      expiresAt: Date.now() + 20 * 365 * 24 * 3600_000,
    });
    expect(device.expiresAt - Date.now()).toBeGreaterThan(9 * 365 * 24 * 3600_000);
    expect(device.expiresAt - Date.now()).toBeLessThan(11 * 365 * 24 * 3600_000);
    const storedDevice = await helpers().unwrapToken(device.token);
    expect(Math.abs(storedDevice!.expiresAt * 1000 - device.expiresAt)).toBeLessThan(2000);
    const secondDevice = await consoleLogin.root.grants.mint({
      name: "Kit HAVPE two",
      projects: [browserA.id],
      clientId: "https://kit.test/devices/havpe/clients/unit-two.json",
    });
    const [, firstDeviceId] = device.token.split(":");
    const [, secondDeviceId] = secondDevice.token.split(":");
    const deviceInventory = await consoleLogin.root.grants.list();
    expect(deviceInventory.items.find((item) => item.id === firstDeviceId)).toMatchObject({
      name: "Kit HAVPE",
      kind: "device",
      clientId: "https://kit.test/devices/havpe/clients/unit-one.json",
      logoUri: "https://kit.test/vendors/home-assistant.png",
    });
    expect(deviceInventory.items.find((item) => item.id === secondDeviceId)?.clientId).toBe(
      "https://kit.test/devices/havpe/clients/unit-two.json",
    );
    const { root: deviceApi } = await rpc(device.token, "bearer");
    expect((await deviceApi.projects.list()).map((p) => p.id)).toEqual([browserA.id]);
    await expect(deviceApi.grants.list()).rejects.toThrow(/Account permission/);
    await consoleLogin.root.grants.end(firstDeviceId!);
    expect(
      await call("/api", { headers: { Authorization: `Bearer ${device.token}` } }),
    ).toMatchObject({ status: 401 });
    const { root: secondDeviceApi } = await rpc(secondDevice.token, "bearer");
    expect((await secondDeviceApi.projects.list()).map((p) => p.id)).toEqual([browserA.id]);
    await expect(
      consoleLogin.root.grants.mint({ name: "Stale", projects: [browserA.id], expiresAt: 1 }),
    ).rejects.toThrow(/at least a minute/);
    expect(
      await call("/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: personal.token,
          client_id: `${ORIGIN}/.auth/client.json`,
        }),
      }),
    ).toMatchObject({ status: 400 });
    const inventory = await consoleLogin.root.grants.list();
    const [, personalId] = personal.token.split(":");
    expect(inventory.items.find((item) => item.id === personalId)).toMatchObject({
      name: "My CLI",
      kind: "personal",
      current: false,
    });
    expect(JSON.stringify(inventory)).not.toContain(personal.token);
    await expect(consoleLogin.root.grants.end("foreign-grant")).rejects.toThrow(
      /Session not found/,
    );
    // a foreign grant ends nothing: no end lands on the account
    expect((await accountStateOf(env, user.id)).endedGrants["foreign-grant"]).toBeUndefined();
    await consoleLogin.root.grants.end(personalId!);
    // the end is on the account — the revocation truth — and the list no longer carries the grant
    expect((await accountStateOf(env, user.id)).endedGrants[personalId!]).toEqual({
      at: expect.any(String),
    });
    expect(
      (await consoleLogin.root.grants.list()).items.find((item) => item.id === personalId),
    ).toBeUndefined();
    expect(
      await tool(personal.token, "run", { project: browserA.id, script: "async () => 1" }),
    ).toMatchObject({ status: 401 });
    const cookieRequest = new Request(`${ORIGIN}/`, { headers: { cookie: consoleLogin.cookie } });
    const heldSession = appSession(env.BROWSER_SESSION, cookieRequest)!;
    const bearerBefore = await heldSession.bearer();
    const providerFailure = vi
      .spyOn(OAuthProvider.prototype, "fetch")
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    onTestFinished(() => {
      providerFailure.mockRestore();
    });
    const failedAdmissionContext = createExecutionContext();
    await expect(browserAuthorization(env, cookieRequest, failedAdmissionContext)).rejects.toThrow(
      /Token admission failed \(503\)/,
    );
    await waitOnExecutionContext(failedAdmissionContext);
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

test("malformed and foreign resources are expected authorization refusals", async () => {
  fetchReachesThisWorker();
  for (const resource of ["not a URL", "https://foreign.test/api"])
    expect(await grant([resource])).toMatchObject({ error: "invalid_target" });
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

/** An admin session — `as` the person `email` names, when given — disposed when the test finishes. */
function actingAs(email?: string) {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  return adminSession(sessions, email);
}

/** A PKCE authorization request for `clientId`, as a client sends it to /oauth2/auth. */
async function authorizationRequest(clientId: string, resources: string[] = []) {
  const verifier =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.test/callback",
    scope: "iterate",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  for (const resource of resources) query.append("resource", resource);
  return { query, verifier };
}

/** The consent capability of the issuer session a browser's sign-in `cookie` holds. */
async function issuerApprover(cookie: string) {
  const issuerSession = appSession(
    env.BROWSER_SESSION,
    new Request(ORIGIN, { headers: { cookie } }),
  )!;
  return (await rpc((await issuerSession.bearer())!)).root;
}

function helpers() {
  return oauthHelpers(env, platformAddressesOf(env, new Request(`${ORIGIN}/`)));
}

/** `fetch` reaches this worker until the test finishes (the network is out of reach here). */
function fetchReachesThisWorker() {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => exports.default.fetch(new Request(input, init)));
  onTestFinished(() => {
    spy.mockRestore();
  });
}

function call(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (path === "/login") headers.set("Authorization", `Bearer ${adminSecret}`);
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers }),
  );
}

async function rpc(
  token: string,
  credential: "from-server-cookie" | "bearer" = "from-server-cookie",
) {
  const response = await call("/api", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  expect(response, await (response.status === 101 ? "" : response.text())).toMatchObject({
    status: 101,
  });
  response.webSocket!.accept();
  // The server's close, as the client sees it: what a row awaits before asserting that every stub
  // is dead — a call sent while the close is in flight surfaces capnweb's `'' is not a function`,
  // not the close reason (2 of 8 Test jobs, 2026-09-22).
  const closed = new Promise<void>((resolve) =>
    response.webSocket!.addEventListener("close", () => resolve(), { once: true }),
  );
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  // The guard's 30 s timer is armed when the socket binds its grant — here, for an upgrade's bearer
  // — so a row that measures the interval measures from this instant, not from its own later revoke.
  const boundAt = Date.now();
  const root = transport.authenticate({ type: credential });
  return { root, closed, boundAt };
}

/** THE REVOCATION TRUTH, landed by hand: `account/grant-ended` on the person's account — the fact
 *  grants.ts `end` awaits before it touches the provider — with the provider's rows left as they
 *  are, so what denies the token next is the account alone (oauth.ts `grantIsRevoked`). */
async function endGrantOnAccount(userId: string, grantId: string): Promise<void> {
  const account = stub(`global.iterate/users/${userId}`);
  await account.invoke(["itx", "processors", ["enable", "account"]]);
  // As grants.ts lands it: through the fixed point, stamped `source.platform` — the only end the
  // account folds.
  await account.invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/account/grant-ended",
          idempotencyKey: `account/grant-ended/${grantId}`,
          payload: { grantId } satisfies GrantEnded,
        },
      ],
    ],
    [],
    { principal: null, platform: true },
  );
}

/** A person's membership of `orgId` removed by the operator — the org given a second owner first
 *  when the person is its last (the control plane keeps at least one). */
async function removeMembership(orgId: string, userId: string): Promise<void> {
  const admin = await actingAs();
  const standIn = await admin.users.create({ email: "oauth-stand-in-owner@example.com" });
  await admin.organizations.addMember(orgId, { userId: standIn.id, role: "owner" });
  await admin.organizations.removeMember(orgId, { userId });
}
async function restoreMembership(orgId: string, userId: string): Promise<void> {
  await (await actingAs()).organizations.addMember(orgId, { userId, role: "owner" });
}

async function tool(token: string, name: string, args: object = {}) {
  const response = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
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

/** Local HTTPS client metadata is not public. Only registration is a fixture;
 * consent, PKCE, exchange, refresh and resource admission all use the real server. The person
 * holds two projects, `oauth-a` and `oauth-b` (their rows come back); the consent ticks the
 * `projects` named by slug — `oauth-a` alone by default. */
async function grant(resources: string[], projects: string[] = ["oauth-a"]) {
  const login = await call("/login", {
    method: "POST",
    body: new URLSearchParams({
      email: "oauth-new@example.com",
      password: loginPassword(),
      next: "/",
    }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  // the sign-in found-or-created the person; their projects are made as them
  const user = await controlPlane().ensureUser("oauth-new@example.com");
  const theirs = await actingAs(user.email);
  using _a = await theirs.projects.create({ project: "oauth-a" });
  using _b = await theirs.projects.create({ project: "oauth-b" });
  const oauthA = (await controlPlane().getProject("oauth-a"))!;
  const oauthB = (await controlPlane().getProject("oauth-b"))!;
  const client = await helpers().createClient({
    clientName: "OAuth integration",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const { query, verifier } = await authorizationRequest(client.clientId, resources);
  const approver = await issuerApprover(cookie);
  // a ticked box submits the project's id
  const approval = await approver.consent.approve({
    query: `?${query}`,
    projects: [oauthA, oauthB]
      .filter((project) => projects.includes(project.slug))
      .map((project) => project.id),
  });
  if ("error" in approval) throw new Error(approval.error);
  const redirect = new URL(approval.redirectTo);
  const code = redirect.searchParams.get("code");
  if (!code)
    return {
      error: redirect.searchParams.get("error"),
      cookie,
      clientId: client.clientId,
      user,
      oauthA,
      oauthB,
    };
  const tokenResponse = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: "https://client.test/callback",
      code_verifier: verifier,
    }),
  });
  const token = await tokenResponse.json<{ access_token: string; refresh_token: string }>();
  expect(tokenResponse, JSON.stringify(token)).toMatchObject({ status: 200 });
  return { token, cookie, clientId: client.clientId, user, oauthA, oauthB };
}
