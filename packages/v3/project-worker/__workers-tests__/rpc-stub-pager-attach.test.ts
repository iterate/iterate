// __workers-tests__/rpc-stub-pager-attach.test.ts — THE ONE-SHOT PAGER ATTACH, inside workerd (the
// workers lane — the only lane that can speak the DO's transport plumbing directly AND read its
// socket census, `rpcStubTransportState`).
//
// Target surface: RpcStubDirectory layer 2 (src/context/rpc-stub-directory.ts). The pager upgrade's
// `x-itx-rpc-stub-pager` header carries the KEY and the EVENTS THAT NAME IT; the DO accepts the
// socket and appends those events in the same turn — the SET half of "the DO owns both ends of a
// lent stub's rule" (the un-set half is the key's last pager close). So a `provide(stub)` is ONE
// edge→DO round trip. A refused append (a paused stream) is the upgrade's answer — a 409 whose JSON
// body carries the code — and leaves NO socket, NO presence and NO row: atomic, because accept and
// append share one synchronous turn. A malformed header is a 400.

import { expect, test } from "vitest";
import { rewriteRuleConfiguredEvent } from "../src/context/itx-expression-rewriting.ts";
import {
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "../src/context/rpc-stub-directory.ts";
import type { StreamEventInput } from "../src/stream/events.ts";
import { Echo, openSession, stub } from "./support.ts";

/** Open a pager upgrade straight at the DO's fetch door (what lendRpcStubOverPager does relay-side):
 *  the header IS the attach request — the key and the events that name it. */
const openPager = (ctx: string, rpcStubKey: string, appendEvents: StreamEventInput[] = []) =>
  stub(ctx).fetch("https://rpc-stub-pager.internal/", {
    headers: {
      Upgrade: "websocket",
      [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
        rpcStubKey,
        appendEvents,
      }),
    },
  });

const ruleFor = (rpcStubKey: string) =>
  rewriteRuleConfiguredEvent(rpcStubKey, ["itx", "rpcStubs", ["get", rpcStubKey]]);

const transportState = async (ctx: string) =>
  (await stub(ctx).rpcStubTransportState()) as unknown as { rpcStubPagers: number };
const presence = (ctx: string) =>
  stub(ctx).invoke(["itx", "rpcStubs", ["list"]]) as Promise<string[]>;
const ruleAt = (ctx: string, match: string) =>
  stub(ctx).invoke(["itx", "rewriteRules", ["get", match]]) as Promise<{ target: string } | null>;

test("a malformed pager header is a 400; a well-formed one attaches the pager AND appends the rule that names its key — one request", async () => {
  const ctx = "prj_pager_attach";
  const malformed = await stub(ctx).fetch("https://rpc-stub-pager.internal/", {
    headers: { Upgrade: "websocket", [RPC_STUB_PAGER_WEBSOCKET_HEADER]: "never-an-attach-request" },
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).toContain("malformed x-itx-rpc-stub-pager header");
  expect((await transportState(ctx)).rpcStubPagers).toBe(0);

  const ok = await openPager(ctx, "itx.k1", [ruleFor("itx.k1")]);
  expect(ok.status).toBe(101);
  ok.webSocket!.accept();
  // The pager is attached, the key is present, and its rule exists — nothing else was called.
  expect((await transportState(ctx)).rpcStubPagers).toBe(1);
  expect(await presence(ctx)).toEqual(["itx.k1"]);
  expect(await ruleAt(ctx, "itx.k1")).toEqual({
    match: "itx.k1",
    target: "itx.rpcStubs.get('itx.k1')",
  });
  ok.webSocket!.close(1000, "test done");
});

test("ATOMIC: a paused stream refuses the attach with 409 + code STREAM_PAUSED, and leaves no socket, no presence, no rule; after resume the same attach lands", async () => {
  const ctx = "prj_pager_attach_refused";
  const s = stub(ctx);
  await s.append({ type: "events.iterate.com/stream/paused", payload: { reason: "test" } });

  const refused = await openPager(ctx, "itx.k2", [ruleFor("itx.k2")]);
  expect(refused.status).toBe(409);
  expect(refused.webSocket).toBeNull();
  const body = (await refused.json()) as { code: string | null; message: string };
  expect(body.code).toBe("STREAM_PAUSED");
  expect(body.message).toContain("stream paused");
  // Nothing happened: accept and append share one synchronous turn, so a refusal un-accepts.
  expect((await transportState(ctx)).rpcStubPagers).toBe(0);
  expect(await presence(ctx)).toEqual([]);
  expect(await ruleAt(ctx, "itx.k2")).toBeNull();

  await s.append({ type: "events.iterate.com/stream/resumed" });
  const ok = await openPager(ctx, "itx.k2", [ruleFor("itx.k2")]);
  expect(ok.status).toBe(101);
  ok.webSocket!.accept();
  expect((await transportState(ctx)).rpcStubPagers).toBe(1);
  expect(await presence(ctx)).toEqual(["itx.k2"]);
  expect((await ruleAt(ctx, "itx.k2"))?.target).toBe("itx.rpcStubs.get('itx.k2')");
  ok.webSocket!.close(1000, "test done");
});

test("HAPPY PATH: provide over /api opens the pager (the rule riding it); a separate caller's invoke pages, borrows and answers", async () => {
  const ctx = "prj_pager_happy";
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  await clientItx.provide("itx.live", new Echo(7));
  const caller = await (await openSession()).authenticate().projects.get(ctx);
  const out = await caller.invoke("itx.live.echo('hi')");
  expect(out).toBe("echo-7:hi");
});
