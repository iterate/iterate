// __workers-tests__/rpc-stub-pager-attach.test.ts — THE TWO-PHASE PAGER ATTACH, inside workerd (the
// workers lane — the only lane that can speak the DO's transport-plumbing Workers-RPC verbs directly).
//
// Target surface: RpcStubDirectory layer 2 (src/context/rpc-stub-directory.ts) — `attachRpcStubPager`
// mints a transportId, then the pager upgrade carrying it is accepted; an UNKNOWN id 409s ("attach
// first"), which is how a relay that outlived a DO restart learns to re-attach. A reservation whose
// pager never arrives costs nothing: it is one in-memory map entry for the incarnation.

import { expect, test } from "vitest";
import { RPC_STUB_PAGER_WEBSOCKET_HEADER } from "../src/context/rpc-stub-directory.ts";
import { Echo, openSession, stub } from "./support.ts";

/** Open a pager upgrade straight at the DO's fetch door (what lendRpcStubOverPager does relay-side). */
const openPager = (ctx: string, transportId: string) =>
  stub(ctx).fetch("https://rpc-stub-pager.internal/", {
    headers: { Upgrade: "websocket", [RPC_STUB_PAGER_WEBSOCKET_HEADER]: transportId },
  });

test("an UNKNOWN transportId 409s at the pager door ('attach first'); a reserved one upgrades and the key shows as a pager", async () => {
  const ctx = "prj_pager_attach";
  const s = stub(ctx);
  const unknown = await openPager(ctx, "never-reserved");
  expect(unknown.status).toBe(409);
  expect(await unknown.text()).toContain("attach first");

  const { transportId } = await s.attachRpcStubPager({ rpcStubKey: "itx.k1" });
  const ok = await openPager(ctx, transportId);
  expect(ok.status).toBe(101);
  ok.webSocket!.accept();
  const state = (await s.rpcStubTransportState()) as unknown as { rpcStubPagers: number };
  expect(state.rpcStubPagers).toBe(1);
  ok.webSocket!.close(1000, "test done");
});

test("HAPPY PATH: provide over /api attaches + opens the pager; a separate caller's invoke pages, borrows and answers", async () => {
  const ctx = "prj_pager_happy";
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  await clientItx.provide("itx.live", new Echo(7));
  const caller = await (await openSession()).authenticate().projects.get(ctx);
  const out = await caller.invoke("itx.live.echo('hi')");
  expect(out).toBe("echo-7:hi");
});
