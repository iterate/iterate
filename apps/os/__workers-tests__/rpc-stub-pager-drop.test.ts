// __workers-tests__/rpc-stub-pager-drop.test.ts — THE PAGER LEG DROPS UNDER A LIVE LEND, inside
// workerd (the Workers suite — the only suite that can close the DO's end of a pager and read its
// socket census, `rpcStubTransportState`).
//
// Target surface: the rpc-stub relay (src/context/rpc-stubs.ts `lendRpcStubOverPager`). A lent
// stub's pager is a WebSocket between the stateless /api isolate and the context DO — a
// Cloudflare-internal connection, never the client's own socket — so it closes while the client's
// session is alive and answering: a fault on the hop between colos, or a DO reset (a
// `state.abort()` kills every hibernatable pager with no close handler run; the relay sees 1006
// "WebSocket disconnected without sending Close frame"). The lend belongs to the SESSION: the relay
// re-dials the pager, the DO's attach re-appends the rule, and a call after the drop answers through
// the same client. Two drops, two shapes: the DO's end goes away (1001), and the DO is reset (the
// sockets vanish; the relay re-dials on a freshly minted DO stub, because one that saw the reset
// would replay it).

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { adminCredentials, Echo, openSession, stub, until } from "./support.ts";

test("the DO's end of the pager closes (1001) under a live session: the relay re-dials, the rule stands, and a call answers", async () => {
  const ctx = "prj_pager_leg_drop";
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await clientItx.provide("itx.dropped", new Echo(3));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  expect(await caller.invoke("itx.dropped.echo('before')")).toBe("echo-3:before");
  expect(await rpcStubPagers(ctx)).toBe(1);

  // THE DROP: the DO's end of every pager goes away — what the relay sees when the hop between its
  // isolate and the DO is torn down; the client's session is untouched.
  await runInDurableObject(stub(ctx), (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.close(1001, "leg dropped");
    return Promise.resolve();
  });

  await until("the relay re-dialed the pager", async () => (await rpcStubPagers(ctx)) === 1);
  const rule = (await stub(ctx).invoke(["itx", "rewriteRules", ["get", "itx.dropped"]])) as {
    target: string;
  } | null;
  expect(rule?.target).toContain("rpcStubs.get('itx.dropped')");
  expect(await caller.invoke("itx.dropped.echo('after')")).toBe("echo-3:after");
});

test("a DO reset kills every pager with no close handler run: the relay re-dials into the fresh incarnation and a call answers", async () => {
  const ctx = "prj_pager_do_reset";
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await clientItx.provide("itx.reset", new Echo(4));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  expect(await caller.invoke("itx.reset.echo('before')")).toBe("echo-4:before");

  // abort() kills the very request running the callback (hibernation-at-scale.test.ts measured it,
  // and the pagers with it), so the call rejects — the reset is the point.
  await runInDurableObject(stub(ctx), (_instance, state) => {
    state.abort("reset under test");
    return Promise.resolve();
  }).catch(() => undefined);

  // the relay gives up after ~4 s; this row waits a little past that
  await until("the relay re-dialed the pager", async () => (await rpcStubPagers(ctx)) === 1, 6_000);
  expect(await caller.invoke("itx.reset.echo('after')")).toBe("echo-4:after");
});

async function rpcStubPagers(ctx: string) {
  return ((await stub(ctx).rpcStubTransportState()) as unknown as { rpcStubPagers: number })
    .rpcStubPagers;
}
