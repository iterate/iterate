// __workers-tests__/secret-facet-proxies-a-socket.test.ts — THE ONE FACET THAT PROXIES A WEBSOCKET.
// A facet reached by itx expression never answers a socket (facets-never-answer-a-socket.test.ts);
// the `secret` facet (src/secret/durable-object.ts) is reached by EGRESS instead: a caller's context
// forwards a placeholder-bearing upgrade to the context at `/secrets/<name>`, whose `#egress` hands it
// to its facet over `ctx.facets.get("secret").fetch(request)`; the facet substitutes the bearer, dials
// the pinned host and hands the 101 straight back — it HOLDS no socket. Measured here, 2026-09-21,
// inside workerd (the workers lane): the 101 crosses every hop (facet → parent → the caller's DO →
// the eyeball), the frames round-trip, the use is a fact on the secret's path; and the socket lives
// exactly as long as the facet's dial — `ctx.facets.abort` on the secret's context closes it, 1006,
// as an intermediary Durable Object's eviction would have. Against the deployed dummy-petshop
// (apps/dummy-petshop), the fixture every secrets proof connects to, over the real network.

import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { expect, test } from "vitest";
import { petshopBaseUrl, petshopLegacyBearer } from "../e2e/support/petshop.ts";
import { stub, until } from "./support.ts";

const SHOP = petshopBaseUrl();

test("a WebSocket 101 through a secret: the caller's context forwards to /secrets/shop, whose facet dials the petshop's capnweb door with the bearer substituted and hands the 101 back; frames round-trip; the use is a fact with status 101; aborting the facet closes the socket 1006", async () => {
  const accessToken = await petshopLegacyBearer("secret-facet-ws@example.com");

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
  expect(response.status).toBe(101);
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
  const used = await until("the secret/used fact", async () => {
    const { events } = (await secret.invoke(["itx", ["readEvents"]])) as {
      events: { type: string; payload?: Record<string, unknown> }[];
    };
    return events.find((event) => event.type === "events.iterate.com/secret/used");
  });
  expect(used.payload).toEqual({ method: "GET", url: `${SHOP}/capnweb`, status: 101 });
  expect(JSON.stringify(used)).not.toContain(accessToken);

  // The socket lives as long as the facet's dial: abort the facet under it.
  await runInDurableObject(secret, (_instance, state) => {
    state.facets.abort("secret", "the pin: a proxied socket dies with the facet that dialled it");
  });
  expect(await closed).toMatchObject({ code: 1006 });
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
  const accessToken = await petshopLegacyBearer("voice-parent-ws@example.com");
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
  expect(response.status, response.status === 101 ? "upgraded" : await response.text()).toBe(101);
  response.webSocket!.accept();
  response.webSocket!.close();
});
