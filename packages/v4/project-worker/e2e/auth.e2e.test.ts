// auth.e2e.test.ts — the configured dashboard identity boundary, through real HTTP only.

import { Buffer } from "node:buffer";
import { createTestHarness, type TestHarness } from "wrangler";
import { afterAll, beforeAll, expect, test } from "vitest";
import { newWebSocketRpcSession } from "capnweb";
import { bundlerWorkerConfig, PACKAGE_DIR, soloWorkerConfig } from "./support/solo-config.ts";

// The dashboard may share the project-host suffix without becoming an unknown project.
const PUBLIC_ORIGIN = "http://auth.localhost";
let server: TestHarness;

beforeAll(async () => {
  const config = soloWorkerConfig();
  server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [
      {
        config: {
          ...config,
          name: "iterate-v4-auth-test",
          services: [
            {
              binding: "FALLBACK",
              service: "iterate-v4-auth-test",
              entrypoint: "DummyControlPlane",
            },
            { binding: "BUNDLER", service: "iterate-v4-simplification-bundler" },
          ],
          kv_namespaces: [...(config.kv_namespaces ?? []), { binding: "OAUTH_KV" }],
          vars: { ...config.vars, PUBLIC_ORIGIN },
        },
      },
      { config: bundlerWorkerConfig() },
    ],
  });
  await server.listen();
});

afterAll(async () => server.close());

test("an unverified email login establishes and clears an explicit browser identity", async () => {
  const origin = PUBLIC_ORIGIN;
  const request = (path: string, init: Parameters<TestHarness["fetch"]>[1] = {}) =>
    server.fetch(new URL(path, PUBLIC_ORIGIN).href, { ...init, redirect: "manual" as const });

  const anonymous = await request("/");
  expect(anonymous.status).toBe(303);
  expect(anonymous.headers.get("location")).toBe("/login");
  expect((await request("/api", { method: "POST" })).status).toBe(401);

  const loginPage = await request("/login");
  expect(loginPage.status).toBe(200);
  expect(await loginPage.text()).toMatch(/no email verification/i);

  const body = new URLSearchParams({ email: "ada@example.com" }).toString();
  expect(
    (
      await request("/login", {
        method: "POST",
        body,
        headers: {
          origin: "https://untrusted.example",
          "content-type": "application/x-www-form-urlencoded",
        },
      })
    ).status,
  ).toBe(403);

  const loggedIn = await request("/login", {
    method: "POST",
    body,
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
  });
  expect(loggedIn.status).toBe(303);
  const setCookie = loggedIn.headers.get("set-cookie");
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Lax/);
  const cookie = setCookie?.split(";", 1)[0];
  expect(cookie).toBeTruthy();

  expect(await (await request("/session", { headers: { cookie: cookie! } })).json()).toEqual({
    email: "ada@example.com",
    verified: false,
  });
  expect(
    (
      await request("/session", {
        headers: { cookie: cookie!, origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api", {
        method: "POST",
        headers: { cookie: cookie!, origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  const rpcResponse = await server.fetch(`${PUBLIC_ORIGIN}/api`, {
    headers: { cookie: cookie!, Upgrade: "websocket" },
  });
  expect(rpcResponse.status).toBe(101);
  if (!rpcResponse.webSocket) throw new Error("expected the authenticated RPC socket");
  rpcResponse.webSocket.accept();
  const api = newWebSocketRpcSession(rpcResponse.webSocket as unknown as WebSocket) as any;
  expect(await api.authenticate({ email: "mallory@example.com" }).identity()).toEqual({
    kind: "unverified-email",
    email: "ada@example.com",
  });
  api[Symbol.dispose]();
  expect((await request("/session", { headers: { cookie: `${cookie}tampered` } })).status).toBe(
    401,
  );

  const loggedOut = await request("/logout", {
    method: "POST",
    headers: { cookie: cookie!, origin },
  });
  expect(loggedOut.status).toBe(303);
  expect(loggedOut.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  expect((await request("/session", { headers: { cookie: cookie! } })).status).toBe(401);
});

test("the same provider issues an S256 PKCE grant scoped to one project", async () => {
  const origin = PUBLIC_ORIGIN;
  const request = (path: string, init: Parameters<TestHarness["fetch"]>[1] = {}) =>
    server.fetch(new URL(path, PUBLIC_ORIGIN).href, { ...init, redirect: "manual" as const });
  const loggedIn = await request("/login", {
    method: "POST",
    body: new URLSearchParams({ email: "ada@example.com" }).toString(),
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = loggedIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();

  const redirectUri = "http://localhost:9876/callback";
  const registered = await request("/register", {
    method: "POST",
    body: JSON.stringify({
      client_name: "Iterate v4 auth test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "content-type": "application/json" },
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const codeVerifier = "iterate-v4-test-pkce-verifier-with-sufficient-length";
  const codeChallenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  ).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "project",
    resource: `${PUBLIC_ORIGIN}/mcp`,
    state: "test-state",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const approved = await request(`/authorize?${authorize}`, {
    method: "POST",
    body: new URLSearchParams({ project: "demo" }).toString(),
    headers: {
      cookie: cookie!,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location")!);
  expect(callback.origin).toBe("http://localhost:9876");
  expect(callback.searchParams.get("state")).toBe("test-state");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokens = await request("/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      code: code!,
      grant_type: "authorization_code",
      resource: `${PUBLIC_ORIGIN}/mcp`,
    }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(tokens.status).toBe(200);
  const { access_token: accessToken } = (await tokens.json()) as { access_token: string };
  expect(accessToken).toBeTruthy();
  expect(
    (
      await request("/mcp?project=not-granted", {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/mcp?project=demo", {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    ).status,
  ).toBe(406);

  const mcp = async (id: number, method: string, params?: unknown) => {
    const response = await request("/mcp?project=demo", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ result: Record<string, unknown> }>;
  };
  expect(
    (
      await mcp(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "iterate-v4-auth-test", version: "1" },
      })
    ).result.protocolVersion,
  ).toBe("2025-03-26");
  expect((await mcp(2, "tools/list", {})).result.tools).toEqual([
    expect.objectContaining({ name: "itx.invoke" }),
  ]);
  const write = await mcp(3, "tools/call", {
    name: "itx.invoke",
    arguments: { expression: "itx.kv.put", args: ["mcp-grant-proof", "scoped-value"] },
  });
  expect(write.result.isError).not.toBe(true);
  const read = await mcp(4, "tools/call", {
    name: "itx.invoke",
    arguments: { expression: "itx.kv.get", args: ["mcp-grant-proof"] },
  });
  expect(read.result.structuredContent).toEqual({ result: "scoped-value" });
});
