// __workers-tests__/secret-facet-proxies-a-socket.test.ts — THE ONE FACET THAT PROXIES A WEBSOCKET.
// A facet reached by itx expression never answers a socket (facets-never-answer-a-socket.test.ts);
// the `secret` facet (src/secret/durable-object.ts) is reached by EGRESS instead: a caller's context
// forwards a placeholder-bearing upgrade to the context at `/secrets/<name>`, whose `#egress` hands it
// to its facet over `ctx.facets.get("secret").fetch(request)`; the facet substitutes the bearer, dials
// the pinned host and hands the 101 straight back — it HOLDS no socket. Measured here, 2026-09-21,
// inside workerd (the Workers suite): the 101 crosses every hop (facet → parent → the caller's DO →
// the eyeball), the frames round-trip, the use is a fact on the secret's path; and the socket lives
// exactly as long as the facet's dial — `ctx.facets.abort` on the secret's context closes it, 1006,
// as an intermediary Durable Object's eviction would have.
//
// THE UPSTREAM IS IN-PROCESS: the facet's terminal `fetch` is the isolate's global fetch, and each
// test answers the pinned origin (`UPSTREAM`) with a fake shop of its own (`serveShop`, below) —
// a real capnweb server over a real WebSocketPair that accepts exactly the bearer the test stored,
// so a 101 is the credential swapped in. This suite dials no deployed service. What it cannot prove
// is the dial over the real network to a real third party; the DEPLOYED row of
// e2e/secrets.e2e.test.ts does that against apps/dummy-petshop.

import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, newWorkersRpcResponse, RpcTarget } from "capnweb";
import { expect, test, vi } from "vitest";
import { readLog, stub, until } from "./support.ts";

const SHOP = "https://petshop.test";

test("a WebSocket 101 through a secret: the caller's context forwards to /secrets/shop, whose facet dials the shop's capnweb endpoint with the bearer substituted and hands the 101 back; frames round-trip; the use is a fact with status 101; aborting the facet closes the socket 1006", async () => {
  const accessToken = serveShop();

  const project = "prj_secret_facet_socket";
  const secret = stub(`${project}.iterate/secrets/shop`);
  expect(
    await stub(project).invoke(
      ["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]],
      [],
      { principal: null },
    ),
  ).toEqual({ path: "/secrets/shop" });

  // The upgrade from ANOTHER context of the project — its `#egress` forwards to the secret's.
  const response = await stub(`${project}.iterate/agents/dialler`).fetch(
    new Request(`${SHOP}/capnweb`, {
      headers: { upgrade: "websocket", authorization: 'Bearer getSecret("/secrets/shop")' },
    }),
  );
  expect(response).toMatchObject({ status: 101 });
  const socket = response.webSocket;
  if (!socket) throw new Error("no webSocket on the 101");
  socket.accept();
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );
  const shop = newWebSocketRpcSession(socket as unknown as WebSocket) as any;
  expect(await shop.getPet("pet-1")).toMatchObject({ id: "pet-1", name: "Biscuit" });

  // The use is a fact on the secret's path — the request as received, never the bearer.
  const used = await until("the secret/used fact", async () =>
    (await readLog(`${project}.iterate/secrets/shop`)).find(
      (event) => event.type === "events.iterate.com/secret/used",
    ),
  );
  expect(used).toMatchObject({ payload: { method: "GET", url: `${SHOP}/capnweb`, status: 101 } });
  expect(JSON.stringify(used)).not.toContain(accessToken);

  // The socket lives as long as the facet's dial: abort the facet under it.
  await runInDurableObject(secret, (_instance, state) => {
    state.facets.abort("secret", "the pin: a proxied socket dies with the facet that dialled it");
  });
  expect(await closed).toMatchObject({ code: 1006 });
});

// A browser cannot set Authorization on a WebSocket, so browser-shaped APIs carry the credential as
// one of the offered subprotocols. The shop's /gateway-subprotocol reads it from
// `petshop.access-token.<token>` and selects `petshop.v1`, as apps/dummy-petshop/src/gateway.ts does.
test("a WebSocket whose credential rides in Sec-WebSocket-Protocol: egress substitutes the placeholder there, the shop's /gateway-subprotocol accepts the upgrade and selects its real subprotocol, and the frames round-trip", async () => {
  const accessToken = serveShop();

  const project = "prj_secret_facet_subprotocol";
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]],
    [],
    { principal: null },
  );

  const response = await stub(`${project}.iterate/agents/browser`).fetch(
    new Request(`${SHOP}/gateway-subprotocol`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": 'petshop.v1, petshop.access-token.getSecret("/secrets/shop")',
      },
    }),
  );
  expect(response).toMatchObject({ status: 101 });
  expect(response.headers.get("sec-websocket-protocol")).toBe("petshop.v1");
  const socket = response.webSocket;
  if (!socket) throw new Error("no webSocket on the 101");
  const frames: unknown[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string));
  });
  const closed = new Promise<never>((_, reject) =>
    socket.addEventListener("close", (event) =>
      reject(new Error(`closed ${event.code} after ${JSON.stringify(frames)}`)),
    ),
  );
  closed.catch(() => {});
  const received = (count: number) =>
    Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (frames.length >= count) resolve();
        };
        socket.addEventListener("message", check);
        check();
      }),
      closed,
    ]);
  socket.accept();

  // The gateway authenticates at the upgrade: a placeholder that reached it unsubstituted is no
  // 101 at all (the fake answers 401), so `ready` is the substituted token accepted.
  await received(2);
  expect(frames).toEqual([{ op: "hello", heartbeatIntervalMs: 30_000 }, { op: "ready" }]);
  socket.send("ping");
  await received(3);
  expect(frames[2]).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

// The deployed voice-agent e2e covers the full loaded-facet and audio path; this isolates the
// parent-context forwarding regression without needing a deployed Worker Loader.
test("an app's fetch expression inherits WebSocket egress through its parent context", async () => {
  const project = "prj_voice_parent_socket";
  const root = stub(project);
  const child = stub(`${project}.iterate/agents/voice`);
  await child.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx", target: ["itx", "builtins", ["cd", "/"]] },
      },
    ],
  ]);
  const accessToken = serveShop();
  await root.invoke(["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]]);
  const response = await child.fetch(
    new Request(`${SHOP}/capnweb`, {
      headers: {
        upgrade: "websocket",
        "x-itx-expression": "itx.fetch",
        "x-itx-app": "1",
        authorization: 'Bearer getSecret("/secrets/shop")',
      },
    }),
  );
  expect(response, response.status === 101 ? "upgraded" : await response.text()).toMatchObject({
    status: 101,
  });
  response.webSocket!.accept();
  response.webSocket!.close();
});

/** The shop at `SHOP` for the rest of the test: the isolate's `fetch` — which the secret facet's
 *  terminal dial is — answers that origin in-process and leaves every other one alone. Its endpoints
 *  accept one freshly minted bearer, returned: `/capnweb` in `Authorization` (a capnweb session
 *  over the socket), `/gateway-subprotocol` as the offered `petshop.access-token.<token>`. Anything
 *  else — an unsubstituted placeholder included — is a 401 and no socket. */
function serveShop(): string {
  const accessToken = `shop-token-${crypto.randomUUID()}`;
  const network = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== SHOP) return network(request);
    return shopFetch(request, accessToken);
  });
  return accessToken;
}

async function shopFetch(request: Request, accessToken: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.headers.get("upgrade") !== "websocket")
    return new Response("a websocket endpoint", { status: 426 });
  if (pathname === "/capnweb") {
    if (request.headers.get("authorization") !== `Bearer ${accessToken}`)
      return new Response("invalid_token", { status: 401 });
    return newWorkersRpcResponse(request, new Shop());
  }
  if (pathname === "/gateway-subprotocol") {
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    if (!offered.includes(`petshop.access-token.${accessToken}`))
      return new Response("invalid_token", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    server.send(JSON.stringify({ op: "hello", heartbeatIntervalMs: 30_000 }));
    server.send(JSON.stringify({ op: "ready" }));
    server.addEventListener("message", (event) => {
      server.send(JSON.stringify({ op: "echo", received: event.data }));
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "petshop.v1" },
    });
  }
  return new Response("not found", { status: 404 });
}

/** The shop's capnweb API, as far as these rows call it. */
class Shop extends RpcTarget {
  getPet(id: string) {
    if (id !== "pet-1") throw new Error(`No pet with id ${id}`);
    return { id: "pet-1", name: "Biscuit", species: "beagle" };
  }
}
