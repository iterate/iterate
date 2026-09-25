// PERSONAL ACCESS TOKENS (src/personal-access-token.ts, grants.ts `mint`, oauth.ts `validateToken`):
// a person's own API key, one bearer at /api, at /mcp and on the hosts of the projects it covers,
// kept on their account as its SHA-256 alone, and refused everywhere from the moment it is revoked.
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import type { PersonalAccessTokenMinted } from "../src/account/contract.ts";
import { platformAddressesOf } from "../src/app-config.ts";
import { accountStateOf, authorizationForToken } from "../src/oauth.ts";
import { sha256Hex } from "../src/caller.ts";
import { indexPersonalAccessToken, newPersonalAccessToken } from "../src/personal-access-token.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  adminSession,
  controlPlane,
  loginPassword,
  ORIGIN,
  publishConfigWorker,
  stub,
} from "./support.ts";

/** An app that answers with what the platform handed it (the principal stamp, the bearer), echoes
 *  a WebSocket's messages, and at `/stream` sends a server-sent event every second until the
 *  connection ends: the connections a key can hold open on a project host. */
const SRC_LIVE_APP = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Live extends WorkerEntrypoint {
  fetch(request) {
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (event) => pair[1].send("echo:" + event.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (new URL(request.url).pathname === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const tick = () => writer.write(new TextEncoder().encode("data: tick\\n\\n")).catch(() => clearInterval(timer));
      const timer = setInterval(tick, 1000);
      tick();
      return new Response(readable, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
    });
  }
}`,
};

test("a personal access token is the person's one bearer at /api, at /mcp and on a covered project's host; an uncovered project is refused at /api and /mcp, and on its host the request arrives anonymous; the account keeps its hash; revoked, it is refused at once and every connection it holds open closes: its /api socket, a project host's WebSocket and a streamed body", async () => {
  fetchReaches();
  const email = "pat-owner@example.com";
  const { account, user } = await signedIn(email);
  const covered = await projectWithEcho(email, "pat-covered");
  const uncovered = await projectWithEcho(email, "pat-uncovered"); // the person reaches it, the key will not
  const principal = { actor: user.id, email };

  const minted = await account.grants.mint({ name: "My script", projects: [covered.id] });
  expect(minted).toEqual({
    id: expect.stringMatching(/^pat_[0-9a-f]{16}$/),
    token: expect.stringMatching(/^itk_/),
    expiresAt: null, // none asked for: it ends when it is revoked
  });
  const { id, token } = minted;
  // THE ACCOUNT'S RECORD: the key's SHA-256, never the key
  const state = await accountStateOf(env, user.id);
  expect(state.personalAccessTokens[id]).toMatchObject({
    name: "My script",
    hash: await sha256Hex(token),
    email,
    projects: [covered.id],
    expiresAt: null,
    mintedBy: expect.any(String), // the issuer session that minted it
    endedAt: null,
  });
  expect(JSON.stringify(state)).not.toContain(token.slice(54));

  // /api: the upgrade's header, and in-band on a bare socket, as the person, within the key's projects
  const live = await rpc(token);
  expect(await live.root.whoami()).toEqual(principal);
  expect((await live.root.projects.list()).map((project) => project.id)).toEqual([covered.id]);
  await expect(live.root.projects.get(uncovered.id)).rejects.toThrow(/outside/);
  using heldProject = await live.root.projects.get(covered.id);
  expect(await heldProject.whoami()).toMatchObject({ projectId: covered.id });
  const bare = await bareSocket();
  expect(await bare.authenticate({ type: "bearer", token }).whoami()).toEqual(principal);
  // a key manages nothing of the account, and opens none of the person's own context
  await expect(live.root.grants.list()).rejects.toThrow(/Account permission/);
  await expect(Promise.resolve().then(() => live.root.user.whoami())).rejects.toThrow(
    /bound to projects/,
  );

  // /mcp: the same key, through an MCP client's handshake and the one tool
  const initialized = await mcp(token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "personal-access-token-test", version: "1.0.0" },
  });
  expect(initialized).toMatchObject({ status: 200 });
  expect(initialized.body.result.instructions).toContain(
    "This token reaches one project, pat-covered",
  );
  const ran = await mcp(token, "tools/call", {
    name: "run",
    arguments: { script: "async (itx) => itx.whoami()" },
  });
  expect(JSON.parse(ran.body.result.content[0].text)).toMatchObject({ projectId: covered.id });
  const outside = await mcp(token, "tools/call", {
    name: "run",
    arguments: { project: uncovered.id, script: "async (itx) => itx.whoami()" },
  });
  expect(outside.body.result).toMatchObject({ isError: true });
  expect(outside.body.result.content[0].text).toMatch(/outside this token's grant/);

  // a covered project's host: the app sees the person and no bearer; on an uncovered one the
  // request arrives anonymous (project-host-sign-in.ts): the key is stamped on nothing
  expect(await (await host(covered.slug, token)).json()).toMatchObject({
    principal,
    authorization: null,
  });
  expect(await (await host(uncovered.slug, token)).json()).toMatchObject({
    principal: null,
    authorization: null,
  });
  // and what the key holds open there: a WebSocket, relayed, and a streamed body
  const hostSocket = await hostWebSocket(covered.slug, token);
  hostSocket.socket.send("ping");
  expect(await hostSocket.next()).toBe("echo:ping");
  const stream = await hostStream(covered.slug, token);
  expect(stream.first).toContain("data: tick");

  // listed as what it is, with its projects and the session that minted it (this one), and never
  // its bearer; its use is recorded
  const listing = await account.grants.list();
  const listed = async () =>
    (await account.grants.list()).items.find((item: { id: string }) => item.id === id);
  expect(await listed()).toMatchObject({
    name: "My script",
    kind: "personal",
    projects: [covered.id],
    expiresAt: null,
    expired: false,
    mintedBy: listing.items.find((item) => item.current)?.id,
  });
  expect(JSON.stringify(await account.grants.list())).not.toContain(token);
  await expect.poll(async () => (await listed())?.lastUsedAt).toBeGreaterThan(0);

  // no key: a well-formed bearer under an id the account holds with another key's hash (the
  // constant-time comparison says no), an id it does not hold, a broken checksum
  const refusals = vi.spyOn(console, "warn");
  onTestFinished(() => {
    refusals.mockRestore();
  });
  const mismatched = await newPersonalAccessToken(user.id);
  await landKey(user.id, {
    id: mismatched.id,
    name: "Another key's hash",
    hash: await sha256Hex(token),
    email,
    projects: [covered.id],
    expiresAt: null,
  });
  // (indexed under its own hash, so the account's record is what refuses it)
  await index(user.id, mismatched.id, mismatched.hash);
  const unknown = await newPersonalAccessToken(user.id);
  for (const wrong of [
    mismatched.token,
    unknown.token,
    `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
  ])
    expect(await call("/api", wrong)).toMatchObject({ status: 401 });
  expect(refusals).toHaveBeenCalledWith({
    event: "oauth.refusal",
    category: "protected-resource",
    reason: "token_unknown_or_expired",
    resource: `${ORIGIN}/api`,
  });
  // no refusal, and nothing else logged, carries a bearer
  expect(JSON.stringify(refusals.mock.calls)).not.toContain(token.slice(54));

  // REVOKED: the end lands on the account before `end` answers, so every entry refuses it at once;
  // then the key's index entry goes, and the key is as unknown as a forged one
  const revokedAt = Date.now();
  await account.grants.end(id);
  refusals.mockClear();
  expect(await call("/api", token)).toMatchObject({ status: 401 });
  expect(await mcp(token, "tools/list", {})).toMatchObject({ status: 401 });
  expect(await host(covered.slug, token)).toMatchObject({ status: 401 });
  await expect(
    Promise.resolve().then(async () =>
      (await bareSocket()).authenticate({ type: "bearer", token }).whoami(),
    ),
  ).rejects.toThrow(/Invalid or revoked bearer/);
  expect(refusals).toHaveBeenCalledWith({
    event: "oauth.refusal",
    category: "protected-resource",
    reason: "token_unknown_or_expired",
    resource: `${ORIGIN}/mcp`,
  });
  // the ACCOUNT is the truth: an index entry that outlived the end (a failed clean-up, KV's
  // propagation) admits nothing
  await index(user.id, id, await sha256Hex(token));
  expect(await mcp(token, "tools/list", {})).toMatchObject({ status: 401 });
  expect(await host(covered.slug, token)).toMatchObject({ status: 401 });
  expect(refusals).toHaveBeenCalledWith({
    event: "oauth.refusal",
    category: "protected-resource",
    reason: "grant_not_live",
    resource: `${ORIGIN}/mcp`,
  });
  expect(await listed()).toBeUndefined();
  expect((await accountStateOf(env, user.id)).personalAccessTokens[id]?.endedAt).toEqual(
    expect.any(String),
  );
  // every connection the key holds open closes at its next re-check: the /api socket (rpc.ts), and
  // the project host's WebSocket and streamed body (project-host-lease.ts), each 30 s after it opened
  const within = <T>(ended: Promise<T>, openedAt: number, what: string) =>
    Promise.race([
      ended,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`the revoked key's ${what} outlived its re-check`)),
          Math.max(0, openedAt + 40_000 - Date.now()),
        ),
      ),
    ]);
  const [, hostClose, streamEndedAt] = await Promise.all([
    within(live.closed, live.boundAt, "/api socket"),
    within(hostSocket.closed, hostSocket.openedAt, "project host WebSocket"),
    within(stream.ended, stream.openedAt, "streamed body"),
  ]);
  expect(hostClose).toMatchObject({ code: 1008 });
  expect(streamEndedAt).toBeGreaterThanOrEqual(revokedAt); // the app never stopped: the edge cut it
  await expect(heldProject.whoami()).rejects.toThrow();
});

test("a key proves itself before any Durable Object is dialled: a well-formed key under an unknown person's id, or a real person's, is refused on the index alone", async () => {
  fetchReaches();
  const email = "pat-real@example.com";
  const { account, user } = await signedIn(email);
  const project = await projectWithEcho(email, "pat-forged");
  // a real person's id is no secret (it is in their keys, `whoami`, event stamps), and a stranger's
  // names no account at all
  const victim = (await controlPlane().ensureUser("pat-victim@example.com"))!.id;
  const stranger = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const dialled = vi.spyOn(env.ITERATE_CONTEXT, "getByName");
  onTestFinished(() => {
    dialled.mockRestore();
  });
  const accountsDialled = (...ids: string[]) =>
    ids.filter((id) => JSON.stringify(dialled.mock.calls).includes(id));
  for (const forger of [stranger, victim]) {
    const { token } = await newPersonalAccessToken(forger); // format and checksum hold
    expect(await call("/api", token)).toMatchObject({ status: 401 });
    expect(await mcp(token, "tools/list", {})).toMatchObject({ status: 401 });
    expect(await host(project.slug, token)).toMatchObject({ status: 401 });
  }
  expect(accountsDialled(stranger, victim)).toEqual([]);
  // the spy does see an account read: a minted key is indexed, so it reaches its person's account
  const { token } = await account.grants.mint({ name: "Real", projects: [project.id] });
  dialled.mockClear();
  expect(await call("/api", token)).not.toMatchObject({ status: 401 });
  expect(accountsDialled(user.id)).toEqual([user.id]);
});

test("the operator bearer is /api's alone: refused at /mcp and on a project host, where its app would see an operator over every project", async () => {
  fetchReaches();
  const project = await projectWithEcho("pat-operator@example.com", "pat-operator");
  const operator = env.APP_CONFIG_SECRETS__ADMIN_BEARER!;
  expect(await mcp(operator, "tools/list", {})).toMatchObject({ status: 401 });
  expect(await host(project.slug, operator)).toMatchObject({ status: 401 });
  const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/api`));
  expect(await authorizationForToken(env, operator, addresses, "api")).toMatchObject({
    principal: { actor: "admin" },
  });
  for (const entryPoint of ["project-host", "browser-session", "secret-oauth-callback"] as const)
    expect(await authorizationForToken(env, operator, addresses, entryPoint)).toBeNull();
});

test("a device's key is listed as the device; an expiring key is refused past its expiry; a mint names a live project and a future expiry", async () => {
  // a device's client metadata document, as Kit publishes one per device (apps/kit/src/device-auth.ts)
  fetchReaches((url) => {
    if (url.href === "https://kit.test/devices/missing.json")
      return new Response("Not found", { status: 404 });
    return Response.json({
      client_id: url.href,
      client_name: "Home Assistant Voice Preview Edition",
      logo_uri: "https://kit.test/vendors/home-assistant.png",
      redirect_uris: ["https://kit.test/.auth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });
  const email = "pat-device@example.com";
  const { account, user } = await signedIn(email);
  const project = await projectWithEcho(email, "pat-device");
  const clientId = "https://kit.test/devices/havpe/clients/unit-one.json";
  const device = await account.grants.mint({
    name: "Kit HAVPE",
    projects: [project.id],
    clientId,
  });
  expect((await account.grants.list()).items.find((item) => item.id === device.id)).toMatchObject({
    name: "Kit HAVPE",
    kind: "device",
    clientId,
    logoUri: "https://kit.test/vendors/home-assistant.png",
    clientDomain: "kit.test",
    expiresAt: null,
  });
  const { root: deviceApi } = await rpc(device.token, "bearer"); // Kit firmware's form (itx_mount.c)
  expect((await deviceApi.projects.list()).map((row) => row.id)).toEqual([project.id]);
  // login.allowedEmails: a key whose person's email the list stops naming is refused, like a grant
  const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/api`));
  const listing = (patterns: string) =>
    ({ ...env, APP_CONFIG_LOGIN__ALLOWED_EMAILS: patterns }) as typeof env;
  expect(
    await authorizationForToken(listing("*@example.com"), device.token, addresses, "api"),
  ).toMatchObject({ principal: { actor: user.id, email } });
  expect(
    await authorizationForToken(listing("*@iterate.com"), device.token, addresses, "api"),
  ).toBeNull();
  await expect(
    account.grants.mint({
      name: "Unavailable device",
      projects: [project.id],
      clientId: "https://kit.test/devices/missing.json",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "The device's OAuth metadata could not be loaded. Try preparing the device again.",
  });

  // an expiry asked for is the key's own; one under a minute away is refused
  const expiresAt = Date.now() + 30 * 24 * 3600_000;
  const expiring = await account.grants.mint({ name: "Month", projects: [project.id], expiresAt });
  expect(expiring).toMatchObject({ expiresAt });
  expect(await call("/api", expiring.token)).not.toMatchObject({ status: 401 });
  await expect(
    account.grants.mint({ name: "Stale", projects: [project.id], expiresAt: Date.now() + 1000 }),
  ).rejects.toThrow(/at least a minute/);
  await expect(account.grants.mint({ name: "Nowhere", projects: ["prj_none"] })).rejects.toThrow(
    /Choose a project you can access/,
  );
  // PAST ITS EXPIRY: a record whose time has come, landed as the mint lands one
  const lapsed = await newPersonalAccessToken(user.id);
  await landKey(user.id, {
    id: lapsed.id,
    name: "Lapsed",
    hash: lapsed.hash,
    email,
    projects: [project.id],
    expiresAt: Date.now() - 1000,
  });
  await index(user.id, lapsed.id, lapsed.hash); // the account's expiry refuses it, not the index
  expect(await call("/api", lapsed.token)).toMatchObject({ status: 401 });
  expect(await mcp(lapsed.token, "tools/list", {})).toMatchObject({ status: 401 });
  // a record a person appends to their own account is no key: only the platform's is folded (the
  // key indexed, so the fold is what refuses it)
  const appended = await newPersonalAccessToken(user.id);
  await index(user.id, appended.id, appended.hash);
  await stub(`global.iterate/users/${user.id}`).invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/account/personal-access-token-minted",
          payload: {
            id: appended.id,
            name: "Forged",
            hash: appended.hash,
            email,
            projects: [project.id],
            expiresAt: null,
            mintedBy: "forged",
          } satisfies PersonalAccessTokenMinted,
        },
      ],
    ],
    [],
    { principal: { actor: user.id, email } },
  );
  expect(await call("/api", appended.token)).toMatchObject({ status: 401 });
});

/** `fetch` reaches this worker (the issuer's sign-in fetches its own client metadata and token
 *  endpoint), and `https://kit.test` answers with `kit`, until the test finishes. */
function fetchReaches(kit?: (url: URL) => Response) {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://kit.test" && kit) return kit(url);
    return exports.default.fetch(request);
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
}

/** The person `email`, signed in at the issuer (the sign-in page's password post): their issuer
 *  session's root, which holds every scope, `account` among them. */
async function signedIn(email: string) {
  const login = await exports.default.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
    }),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const issuer = appSession(env.BROWSER_SESSION, new Request(ORIGIN, { headers: { cookie } }))!;
  const { root } = await rpc((await issuer.bearer())!);
  return { account: root, user: (await controlPlane().ensureUser(email))! };
}

/** A project of `email`'s, made as them, its config worker the live app: `echo--<slug>.projects.test`
 *  reaches it. */
async function projectWithEcho(email: string, slug: string) {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  using project = await (await adminSession(sessions, email)).projects.create({ project: slug });
  await publishConfigWorker(project, ["itx", "workers", ["get", { source: SRC_LIVE_APP }]]);
  return (await controlPlane().getProject(slug))!;
}

/** The key's index entry, as grants.ts writes it before the record (personal-access-token.ts). */
async function index(userId: string, id: string, hash: string) {
  await indexPersonalAccessToken(env.OAUTH_KV, { hash, userId, id, expiresAt: null });
}

/** The key's record on the account, as grants.ts lands it: through the fixed point, stamped
 *  `source.platform`, the only record the account folds. Not indexed: `index` does that. */
async function landKey(userId: string, key: Omit<PersonalAccessTokenMinted, "mintedBy">) {
  const account = stub(`global.iterate/users/${userId}`);
  await account.invoke(["itx", "processors", ["enable", "account"]]);
  await account.invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/account/personal-access-token-minted",
          idempotencyKey: `account/personal-access-token-minted/${key.id}`,
          payload: { ...key, mintedBy: "test" } satisfies PersonalAccessTokenMinted,
        },
      ],
    ],
    [],
    { principal: null, platform: true },
  );
}

function call(path: string, bearer: string) {
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      body: "",
      headers: { Authorization: `Bearer ${bearer}` },
    }),
  );
}

function host(slug: string, bearer: string) {
  return exports.default.fetch(`https://echo--${slug}.projects.test/`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

/** A WebSocket on the project host with `bearer`: its messages in order, and its close. */
async function hostWebSocket(slug: string, bearer: string) {
  const response = await exports.default.fetch(`https://echo--${slug}.projects.test/`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${bearer}` },
  });
  expect(response, response.status === 101 ? "" : await response.text()).toMatchObject({
    status: 101,
  });
  const socket = response.webSocket!;
  socket.accept();
  const openedAt = Date.now();
  const messages: string[] = [];
  const waiting: ((message: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = String(event.data);
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason }), {
      once: true,
    }),
  );
  onTestFinished(() => {
    try {
      socket.close(1000, "done");
    } catch {
      // closed by the revocation
    }
  });
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift()!)
      : new Promise<string>((resolve) => waiting.push(resolve));
  return { socket, next, closed, openedAt };
}

/** The project host's `/stream` with `bearer`: its first chunk as text, and when it ended, read on
 *  from there (errored or finished, while the app still sends every second). */
async function hostStream(slug: string, bearer: string) {
  const response = await exports.default.fetch(`https://echo--${slug}.projects.test/stream`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(response).toMatchObject({ status: 200 });
  const openedAt = Date.now();
  const reader = response.body!.getReader();
  onTestFinished(() => reader.cancel().catch(() => {}));
  const first = new TextDecoder().decode((await reader.read()).value);
  const ended = (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      // aborted by the edge
    }
    return Date.now();
  })();
  return { first, ended, openedAt };
}

/** `/api` upgraded with `token` on the header, as a script or a device opens it: the root, the
 *  server's close as the client sees it, and when the guard's 30 s re-check was armed. */
async function rpc(
  token: string,
  credential: "from-server-cookie" | "bearer" = "from-server-cookie",
) {
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  expect(response, response.status === 101 ? "" : await response.text()).toMatchObject({
    status: 101,
  });
  response.webSocket!.accept();
  const closed = new Promise<void>((resolve) =>
    response.webSocket!.addEventListener("close", () => resolve(), { once: true }),
  );
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  const boundAt = Date.now();
  return { root: transport.authenticate({ type: credential }), closed, boundAt };
}

/** `/api` opened BARE, as a browser page on another origin opens it: it authenticates in-band. */
async function bareSocket() {
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  return transport;
}

/** One MCP JSON-RPC request with `bearer`: its status and, when 200, its JSON-RPC answer. */
async function mcp(bearer: string, method: string, params: object) {
  const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, body: null };
  const body = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((message) => message.id === 1)
    : JSON.parse(text);
  return { status: response.status, body };
}
