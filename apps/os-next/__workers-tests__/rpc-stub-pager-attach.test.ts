// __workers-tests__/rpc-stub-pager-attach.test.ts — THE ONE-SHOT PAGER ATTACH, inside workerd (the
// workers lane — the only lane that can speak the DO's transport plumbing directly AND read its
// socket census, `rpcStubTransportState`).
//
// Target surface: RpcStubDirectory layer 2 (src/context/rpc-stubs.ts). The pager upgrade's
// `x-itx-rpc-stub-pager` header carries the KEY and the EVENTS THAT NAME IT; the DO accepts the
// socket and appends those events in the same turn — the SET half of "the DO owns both ends of a
// lent stub's rule" (the un-set half is the key's last pager close). So a `provide(stub)` is ONE
// edge→DO round trip. A refused append (a paused stream) is the upgrade's answer — a 409 whose JSON
// body carries the code — and leaves NO socket, NO presence and NO row: atomic, because accept and
// append share one synchronous turn. A malformed header is a 400.
//
// The UN-SET half, same layer: the key's last pager close appends the removal — refused under a
// pause, it lands on the `resumed` commit; a match at itx.builtins (the one row the removal spelling
// could never express) is refused AT THE DOOR, so no such row can ever sit beside the real ones. And
// a pager REPLACED at its key (a reconnect) is a reconnect, not a close: a page in flight survives
// the swap and the new pager's lend answers it.

import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "../src/context/rpc-stubs.ts";
import type { StreamEventInput } from "../src/stream/processor.ts";
import { adminCredentials, Echo, openSession, stub, until } from "./support.ts";

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

const ruleFor = (rpcStubKey: string): StreamEventInput => ({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: rpcStubKey, target: ["itx", "rpcStubs", ["get", rpcStubKey]] },
});

const transportState = async (ctx: string) =>
  (await stub(ctx).rpcStubTransportState()) as unknown as {
    rpcStubPagers: number;
    rpcStubPagesInFlight: number;
  };
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
    target: "itx.rpcStubs.get('itx.k1')", // stored as the lender spelled it (it resolves through the platform row)
    origin: "context",
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
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await clientItx.provide("itx.live", new Echo(7));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  const out = await caller.invoke("itx.live.echo('hi')");
  expect(out).toBe("echo-7:hi");
});

// ── the un-set half: the key's LAST pager close ──

test("a stub whose last pager closes DURING a pause keeps its rule (the un-set append is refused) and is un-set once the stream resumes", async () => {
  const ctx = "prj_pager_pause_unset";
  const s = stub(ctx);
  const pager = await openPager(ctx, "itx.k5", [ruleFor("itx.k5")]);
  expect(pager.status).toBe(101);
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/stream/paused", payload: { reason: "test" } });
  pager.webSocket!.close(1000, "session died while paused");
  await until("the pager is gone", async () => (await transportState(ctx)).rpcStubPagers === 0);
  // the un-set was refused by the pause: the row stands (the window)
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/stream/resumed" });
  await until("the rule un-set after resume", async () => (await ruleAt(ctx, "itx.k5")) === null);
});

test("the append door REFUSES a rule match rooted at itx.builtins (the reserved fixed point is no rule's to claim) — the un-expressible row can never enter the log beside the real ones", async () => {
  const ctx = "prj_pager_raw_builtins_row";
  // The door validates every append: a match at itx.builtins — the fixed point every call rewrites
  // TO — is refused, so the "raw row the removal spelling cannot express" can never enter the log to
  // begin with (a raw append once bypassed the builder; the boundary is the door now).
  await runInDurableObject(stub(ctx), async (instance) => {
    await expect(
      instance.append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.builtins.foo", target: "itx.builtins.rpcStubs.get('itx.k7')" },
      }),
    ).rejects.toThrow(/itx\.builtins/);
  });
  // and a real rule's own un-set sweep is untouched: the pager's last close un-sets itx.k7's row.
  const pager = await openPager(ctx, "itx.k7", [ruleFor("itx.k7")]);
  expect(pager.status).toBe(101);
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k7"))?.target).toBe("itx.rpcStubs.get('itx.k7')");
  pager.webSocket!.close(1000, "last pager");
  await until("itx.k7's own rule is un-set", async () => (await ruleAt(ctx, "itx.k7")) === null);
});

// ── a replaced pager is a reconnect, not a close ──

/** What a relay lends: the `invoke(steps)` half of a BorrowedRpcStub, tagged. */
class LentAnswer extends RpcTarget {
  readonly #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  async invoke(itxExpressionSteps: unknown[]): Promise<string> {
    return `${this.#tag}:${JSON.stringify(itxExpressionSteps)}`;
  }
}

test("a pager RECONNECT while a page is in flight is a reconnect, not a close: the page (per KEY, not per socket) survives the swap and the new pager's lend answers it", async () => {
  const ctx = "prj_pager_reconnect_midpage";
  const s = stub(ctx);
  const rpcStubKey = "itx.reconnecting";

  // Pager #1 is attached but DELIBERATELY never answers — the relay whose isolate is on its way
  // out, the one a client reconnects to replace.
  let pagesSeenByFirstPager = 0;
  const first = await openPager(ctx, rpcStubKey);
  first.webSocket!.accept();
  first.webSocket!.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"')) pagesSeenByFirstPager++;
  });

  // A cold call on the key: nothing borrowed, so the DO pages and waits.
  const call = s.invoke([
    "itx",
    "rpcStubs",
    ["get", rpcStubKey],
    ["echo", "hi"],
  ]) as Promise<unknown>;
  call.catch(() => undefined); // settled by the assertion below, never an unhandled rejection
  await until("the page reached pager #1", () => pagesSeenByFirstPager > 0);
  expect((await transportState(ctx)).rpcStubPagesInFlight).toBe(1);

  // THE RECONNECT: the client re-provides at the same key from a fresh relay. Its pager attaches
  // (the DO drops pager #1 as "replaced") and it answers pages with a lend, like any relay.
  const second = await openPager(ctx, rpcStubKey);
  second.webSocket!.accept();
  second.webSocket!.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"'))
      void s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });
  });
  await s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });

  try {
    // The stub is right there under the key — the waiting call is served, not refused.
    await expect(call).resolves.toContain("reconnected");
  } finally {
    first.webSocket!.close(1000, "test done");
    second.webSocket!.close(1000, "test done");
  }
});
