// __workers-tests__/oauth-support.ts — what oauth.test.ts and the oauth-recheck-*.test.ts files share:
// a person's grant through the real sign-in and consent, the worker's own fetch and /api socket, and
// the operator's hand on the account and the membership. The re-check rows wait the guard's real
// 30 s timer, so each is a file of its own: vitest runs files beside each other, the rows of one
// file one after another (vitest.config.ts LONG_POLES).
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import { expect, onTestFinished, vi } from "vitest";
import { appSession } from "iterate/app-server";
import { platformAddressesOf } from "../src/app-config.ts";
import type { GrantEnded } from "../src/account/contract.ts";
import { oauthHelpers } from "../src/oauth.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { adminSession, controlPlane, loginPassword, ORIGIN, stub } from "./support.ts";
const adminSecret = env.APP_CONFIG_SECRETS__ADMIN_BEARER!;

/** An admin session — `as` the person `email` names, when given — disposed when the test finishes. */
export function actingAs(email?: string) {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  return adminSession(sessions, email);
}

/** A PKCE authorization request for `clientId`, as a client sends it to /oauth2/auth. */
export async function authorizationRequest(clientId: string, resources: string[] = []) {
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
export async function issuerApprover(cookie: string) {
  const issuerSession = appSession(
    env.BROWSER_SESSION,
    new Request(ORIGIN, { headers: { cookie } }),
  )!;
  return (await rpc((await issuerSession.bearer())!)).root;
}

export function helpers() {
  return oauthHelpers(env, platformAddressesOf(env, new Request(`${ORIGIN}/`)));
}

/** `fetch` reaches this worker until the test finishes (the network is out of reach here). */
export function fetchReachesThisWorker() {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => exports.default.fetch(new Request(input, init)));
  onTestFinished(() => {
    spy.mockRestore();
  });
}

export function call(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (path === "/login") headers.set("Authorization", `Bearer ${adminSecret}`);
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers }),
  );
}

export async function rpc(
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
 *  are, so what denies the token next is the account alone (oauth.ts `grantIsLive`). */
export async function endGrantOnAccount(userId: string, grantId: string): Promise<void> {
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
export async function removeMembership(orgId: string, userId: string): Promise<void> {
  const admin = await actingAs();
  const standIn = await admin.users.create({ email: "oauth-stand-in-owner@example.com" });
  await admin.organizations.addMember(orgId, { userId: standIn.id, role: "owner" });
  await admin.organizations.removeMember(orgId, { userId });
}
export async function restoreMembership(orgId: string, userId: string): Promise<void> {
  await (await actingAs()).organizations.addMember(orgId, { userId, role: "owner" });
}

/** Local HTTPS client metadata is not public. Only registration is a fixture;
 * consent, PKCE, exchange, refresh and resource admission all use the real server. The person
 * holds two projects, `oauth-a` and `oauth-b` (their rows come back); the consent ticks the
 * `projects` named by slug — `oauth-a` alone by default. */
export async function grant(resources: string[], projects: string[] = ["oauth-a"]) {
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

/** THE GRANT ENDS UNDER A LIVE SESSION — revoked on the person's account, or their membership removed:
 *  the guard's own 30 s re-check closes the socket, and every capability the session held dies
 *  with it: the context, a worker it made, a stub it lent. One row per reason, each in its own file. */
export async function liveSessionLosesHeldCapabilities(reason: "revoked" | "membership") {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const { root, closed, boundAt } = await rpc(flow.token!.access_token);
  using context = await root.projects.get(flow.oauthA.id);
  const native = (await context.invoke(
    `itx.workers.get({source: {"worker.js": "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { ping() { return 'pong'; } }"}})`,
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
}
