// __workers-tests__/secret-sockets-over-lends.test.ts — OUTBOUND WEBSOCKETS THROUGH A SECRET, over
// every hop a use can take: a project's own secret, and a person's secret LENT to the project (the
// dialler's context → the borrowed path's context and its facet → the lender's context and its facet
// → the upstream). Two auth shapes, the two the pet shop's gateways model (apps/dummy-petshop
// src/gateway.ts): the OpenAI-Realtime shape (`/gateway-header`, the bearer on the UPGRADE) and the
// Discord shape (`/gateway`, no auth on the upgrade — the token rides INSIDE the first client frame,
// IDENTIFY `{"op":2,"d":{"token":…}}`).
//
// THE UPSTREAM IS IN-PROCESS, as in secret-facet-proxies-a-socket.test.ts: the facet's terminal
// `fetch` is the isolate's global fetch, answered for `SHOP` by `serveGateways` below.

import { expect, onTestFinished, test, vi } from "vitest";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import { adminSession, projectWithMember, stub } from "./support.ts";

const SHOP = "https://gateway.test";

test("OpenAI-Realtime shape, a project's own secret: the bearer is substituted on the upgrade and the frames round-trip", async () => {
  const { token } = serveGateways();
  const project = "prj_ws_header_own";
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/realtime", token, { urls: [SHOP] }]],
    [],
    { principal: null },
  );
  const socket = await upgrade(`${project}.iterate/agents/dialler`, "/gateway-header", {
    authorization: 'Bearer getSecret("/secrets/realtime")',
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.send("ping");
  expect(await socket.next()).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

test("OpenAI-Realtime shape, a person's secret LENT to the project: the upgrade crosses the borrowed path to the lender's facet and the 101 comes back", async () => {
  const lender = await projectWithMember("ws-lend-header");
  const { token } = serveGateways();
  await lender.session.user.secrets.set("/secrets/realtime-mine", token, { urls: [SHOP] });
  await lender.session.user.secrets.lend("/secrets/realtime-mine", {
    to: lender.projectId,
    as: "/secrets/realtime",
  });
  const socket = await upgrade(`${lender.projectId}.iterate/agents/dialler`, "/gateway-header", {
    authorization: 'Bearer getSecret("/secrets/realtime")',
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.send("ping");
  expect(await socket.next()).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

test("OpenAI-Realtime shape, the INSTANCE's key lent to every project: the upgrade crosses the borrowed path to the instance's facet and the 101 comes back", async () => {
  const project = await projectWithMember("ws-lend-instance");
  const { token } = serveGateways();
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  const global = (await adminSession(sessions)).global;
  const as = `/secrets/realtime-${crypto.randomUUID().slice(0, 8)}`;
  await global.secrets.set("/secrets/realtime-instance", token, { urls: [SHOP] });
  const { lendId } = await global.secrets.lend("/secrets/realtime-instance", {
    to: "every-project",
    as,
  });
  onTestFinished(async () => {
    await global.secrets.revokeLend("/secrets/realtime-instance", lendId);
  });
  const socket = await upgrade(`${project.projectId}.iterate/agents/dialler`, "/gateway-header", {
    authorization: `Bearer getSecret("${as}")`,
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.send("ping");
  expect(await socket.next()).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

test("a lend is one hop by construction: a project's borrowed secret cannot be lent on", async () => {
  const lender = await projectWithMember("ws-lend-of-lend");
  serveGateways();
  await lender.session.user.secrets.set("/secrets/mine", "t", { urls: [SHOP] });
  await lender.session.user.secrets.lend("/secrets/mine", {
    to: lender.projectId,
    as: "/secrets/borrowed",
  });
  await expect(
    lender.itx.secrets.lend("/secrets/borrowed", { to: lender.projectId, as: "/secrets/again" }),
  ).rejects.toThrow(/a person lends their own secrets/);
});

test("Discord shape, a project's own secret: the upgrade names the secret, and the placeholder in the IDENTIFY frame is substituted", async () => {
  const { token, upstreamCloses } = serveGateways();
  const project = "prj_ws_frame_own";
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/discord", token, { urls: [SHOP] }]],
    [],
    { principal: null },
  );
  const socket = await upgrade(`${project}.iterate/agents/bot`, "/gateway", {
    "x-itx-secret-frames": 'getSecret("/secrets/discord")',
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  socket.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")' } }));
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.send("ping");
  expect(await socket.next()).toEqual({ op: "echo", received: "ping" });
  // the caller's close reaches the upstream: the proxy holds no socket past its caller
  socket.close(1000, "bye");
  await vi.waitUntil(() => upstreamCloses.length > 0);
  expect(upstreamCloses).toEqual([1000]);

  // a frame naming another secret closes both sides, 1008, and sends nothing
  const second = await upgrade(`${project}.iterate/agents/bot`, "/gateway", {
    "x-itx-secret-frames": 'getSecret("/secrets/discord")',
  });
  expect(await second.next()).toEqual({ op: "hello" });
  second.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/other")' } }));
  await expect(second.next()).rejects.toThrow(/closed 1008/);
});

test("Discord shape without the frames header: the placeholder reaches the upstream literally and IDENTIFY fails, 4001", async () => {
  const { token } = serveGateways();
  const project = "prj_ws_frame_unnamed";
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/discord", token, { urls: [SHOP] }]],
    [],
    { principal: null },
  );
  // no placeholder on the upgrade: egress routes it to no secret, straight to the network
  const socket = await upgrade(`${project}.iterate/agents/bot`, "/gateway", {});
  expect(await socket.next()).toEqual({ op: "hello" });
  socket.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")' } }));
  await expect(socket.next()).rejects.toThrow(/closed 4001/);
});

test("Discord shape, a person's secret LENT to the project: the frame placeholder is substituted at the lender", async () => {
  const lender = await projectWithMember("ws-lend-frame");
  const { token } = serveGateways();
  await lender.session.user.secrets.set("/secrets/discord-mine", token, { urls: [SHOP] });
  await lender.session.user.secrets.lend("/secrets/discord-mine", {
    to: lender.projectId,
    as: "/secrets/discord",
  });
  const socket = await upgrade(`${lender.projectId}.iterate/agents/bot`, "/gateway", {
    "x-itx-secret-frames": 'getSecret("/secrets/discord")',
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  socket.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")' } }));
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.send("ping");
  expect(await socket.next()).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

test("the deepest chain: LOADED CODE's fetch (an app context's itx.fetch, through its parent) → the borrowed path → the lender, Discord shape", async () => {
  const lender = await projectWithMember("ws-lend-app");
  const { token } = serveGateways();
  await lender.session.user.secrets.set("/secrets/discord-mine", token, { urls: [SHOP] });
  await lender.session.user.secrets.lend("/secrets/discord-mine", {
    to: lender.projectId,
    as: "/secrets/discord",
  });
  const child = `${lender.projectId}.iterate/agents/voice`;
  await stub(child).invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx", target: ["itx", "builtins", ["cd", "/"]] },
      },
    ],
  ]);
  const socket = await upgrade(child, "/gateway", {
    "x-itx-expression": "itx.fetch",
    "x-itx-app": "1",
    "x-itx-secret-frames": 'getSecret("/secrets/discord")',
  });
  expect(await socket.next()).toEqual({ op: "hello" });
  socket.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")' } }));
  expect(await socket.next()).toEqual({ op: "ready" });
  socket.close();
});

test("a lend use is the platform's alone: a caller's x-itx-lend-* headers are stripped at egress, and an unsigned one at the lender is a 502", async () => {
  const lender = await projectWithMember("ws-lend-forged");
  const { token } = serveGateways();
  await lender.session.user.secrets.set("/secrets/mine", token, { urls: [SHOP] });
  const { actor } = await lender.session.whoami();
  const lenderContext = DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${actor}/secrets/mine`,
  });
  // straight at the lender's context, with a forged lend: refused
  const forged = await stub(lenderContext).fetch(
    new Request(`${SHOP}/gateway-header`, {
      headers: {
        upgrade: "websocket",
        "x-itx-lend-use": "forged.token",
        authorization: 'Bearer getSecret("/secrets/mine")',
      },
    }),
  );
  expect(forged).toMatchObject({ status: 502 });
  // through a project context's egress, claiming to be lent as the path it names: stripped, so
  // the project's own (absent) secret answers
  const stripped = await stub(`${lender.projectId}.iterate/agents/x`).fetch(
    new Request(`${SHOP}/gateway-header`, {
      headers: {
        upgrade: "websocket",
        "x-itx-lend-as": JSON.stringify({ as: "/secrets/mine", borrower: lender.projectId }),
        authorization: 'Bearer getSecret("/secrets/mine")',
      },
    }),
  );
  expect(stripped).toMatchObject({ status: 502 });
  expect(await stripped.text()).toMatch(/no stored project secret/);
});

/** An upgrade from the context `ctx` (its egress), accepted; `next()` is the next frame, parsed. */
async function upgrade(ctx: string, pathname: string, headers: Record<string, string>) {
  const response = await stub(ctx).fetch(
    new Request(`${SHOP}${pathname}`, { headers: { upgrade: "websocket", ...headers } }),
  );
  if (response.status !== 101)
    throw new Error(`upgrade answered ${response.status}: ${await response.text()}`);
  const socket = response.webSocket!;
  const frames: unknown[] = [];
  const waiters: (() => void)[] = [];
  let closed: string | null = null;
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string));
    waiters.splice(0).forEach((wake) => wake());
  });
  socket.addEventListener("close", (event) => {
    closed = `closed ${event.code} ${event.reason}`;
    waiters.splice(0).forEach((wake) => wake());
  });
  socket.accept();
  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    async next(): Promise<unknown> {
      while (frames.length === 0) {
        if (closed) throw new Error(closed);
        await new Promise<void>((wake) => waiters.push(wake));
      }
      return frames.shift();
    },
  };
}

/** The gateways at `SHOP` for the rest of the test, accepting one freshly minted token, returned:
 *  `/gateway-header` in `Authorization: Bearer` at the upgrade (hello, ready); `/gateway` in the
 *  first client frame, IDENTIFY `{op: 2, d: {token}}` (hello; ready, or close 4001). Then each
 *  frame is echoed. An unsubstituted placeholder is a wrong token. */
function serveGateways() {
  const token = `gateway-token-${crypto.randomUUID()}`;
  const upstreamCloses: number[] = [];
  const network = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== SHOP) return network(request);
    const { pathname } = new URL(request.url);
    if (request.headers.get("upgrade") !== "websocket") return new Response(null, { status: 426 });
    const header = pathname === "/gateway-header";
    if (!header && pathname !== "/gateway") return new Response(null, { status: 404 });
    if (header && request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("invalid_token", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.addEventListener("close", (event) => upstreamCloses.push(event.code));
    server.accept();
    server.send(JSON.stringify({ op: "hello" }));
    let identified = header;
    if (header) server.send(JSON.stringify({ op: "ready" }));
    server.addEventListener("message", (event) => {
      if (identified) return server.send(JSON.stringify({ op: "echo", received: event.data }));
      const identify = JSON.parse(event.data as string) as { op?: number; d?: { token?: string } };
      if (identify.op !== 2 || identify.d?.token !== token)
        return server.close(4001, "authentication failed");
      identified = true;
      server.send(JSON.stringify({ op: "ready" }));
    });
    return new Response(null, { status: 101, webSocket: client });
  });
  onTestFinished(() => spy.mockRestore());
  return { token, upstreamCloses };
}
