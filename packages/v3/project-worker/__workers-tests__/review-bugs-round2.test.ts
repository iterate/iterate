// __workers-tests__/review-bugs-round2.test.ts — the proofs of the 2026-09-04 round-2 bug hunt that
// need the DO's real transport plumbing and its socket census (docs/reviews/2026-09-04-round2-
// bugs-do-side.md and -edge-side.md). Every test is titled `<report>#<n>`; `test.fails` is the house
// convention for a known-red proof, and flipping it back to `test` is how a fix is proved. Each was
// run RED first.

import { expect, test } from "vitest";
import { rewriteRuleConfiguredEvent } from "../src/context/itx-expression-rewriting.ts";
import { lendRpcStubOverPager } from "../src/context/rpc-stub-relay.ts";
import {
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "../src/context/rpc-stub-directory.ts";
import type { StreamEventInput } from "../src/stream/events.ts";
import { stub } from "./support.ts";

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
  rewriteRuleConfiguredEvent(rpcStubKey, ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]]);
const ruleAt = (ctx: string, match: string) =>
  stub(ctx).invoke(["itx", "builtins", "rewriteRules", ["get", match]]) as Promise<{
    target: string | null;
    origin: string;
  } | null>;
const until = async <T>(label: string, fn: () => Promise<T | null | undefined | false>) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > 5000) throw new Error(`until(${label}): timed out`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

// do-side#7 — BUG (fixed): the relay dup'd the client's stub for the session, then awaited the DO's
// fetch with no try/catch — a REJECTED fetch (the DO's constructor throwing on a bad APP_CONFIG_* var)
// propagated with the dup alive for the session's life. FIX: dispose the dup before re-throwing.
test("do-side#7: a DO fetch that REJECTS releases the session's dup", async () => {
  let disposed = 0;
  const lent = {
    onRpcBroken() {},
    [Symbol.dispose]() {
      disposed += 1;
    },
  };
  const provider = { dup: () => lent };
  const context = {
    fetch: async () => {
      throw new Error("APP_CONFIG_ENVIRONMENT_NAME: required, got nothing");
    },
  };
  await expect(
    lendRpcStubOverPager(
      context as unknown as Parameters<typeof lendRpcStubOverPager>[0],
      provider as unknown as Parameters<typeof lendRpcStubOverPager>[1],
      "key-1",
      [],
      () => {},
    ),
  ).rejects.toThrow(/APP_CONFIG_ENVIRONMENT_NAME/);
  expect(disposed).toBe(1);
});

// do-side#5 — BUG (fixed): the un-set of what names a dead stub is fire-and-forget, and a PAUSED
// stream refuses it — a stub whose last pager closed during a pause kept its rule forever
// (RPC_STUB_OFFLINE, and the platform row beneath unreachable). FIX: on the `resumed` commit, every
// key a row still names that has no transport is un-set.
test("do-side#5: a stub whose last pager closes DURING a pause has its rule un-set once the stream resumes", async () => {
  const ctx = "prj_round2_pause_unset";
  const s = stub(ctx);
  const pager = await openPager(ctx, "itx.k5", [ruleFor("itx.k5")]);
  expect(pager.status).toBe(101);
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.builtins.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/stream/paused", payload: { reason: "test" } });
  pager.webSocket!.close(1000, "session died while paused");
  // the un-set was refused by the pause: the row stands (documenting the window)
  await until(
    "the pager is gone",
    async () =>
      ((await s.rpcStubTransportState()) as unknown as { rpcStubPagers: number }).rpcStubPagers ===
      0,
  );
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.builtins.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/stream/resumed" });
  await until(
    "the rule is un-set after resume",
    async () => (await ruleAt(ctx, "itx.k5")) === null,
  );
});

// edge#7(ii) — BUG (fixed): a stored row whose match is rooted at `itx.builtins` (raw-appended — the
// reduce has no door) made `rewriteRuleRemovedEvent` THROW inside the un-set loop, so every later row
// naming the key stayed set. FIX: each removal is built on its own; one unremovable row stops nothing.
test("edge#7(ii): a raw row the removal spelling cannot express does not stop the other rows' un-set", async () => {
  const ctx = "prj_round2_raw_builtins_row";
  const s = stub(ctx);
  // the raw event bypasses the door: the reduce stores a row at the fixed point
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.builtins.foo", target: "itx.builtins.rpcStubs.get('itx.k7')" },
  });
  const pager = await openPager(ctx, "itx.k7", [ruleFor("itx.k7")]);
  expect(pager.status).toBe(101);
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k7"))?.target).toBe("itx.builtins.rpcStubs.get('itx.k7')");
  pager.webSocket!.close(1000, "last pager");
  await until("itx.k7's own rule is un-set", async () => (await ruleAt(ctx, "itx.k7")) === null);
});

// edge#11 / do-side#9 — BUG (fixed): `rewriteRules.get(match)` compared the caller's spelling to the
// canonical key, so `get('itx.ai.run("x")')` was null for a row `provide` accepted. FIX: canonicalize.
test("edge#11: rewriteRules.get accepts any spelling of the match", async () => {
  const ctx = "prj_round2_get_canonical";
  const s = stub(ctx);
  await s.append(rewriteRuleConfiguredEvent("itx.ai.run('x', {b:1, a:2})", "itx.builtins.whoami"));
  for (const spelling of [
    "itx.ai.run('x',{a:2,b:1})",
    'itx.ai.run("x", { b: 1, a: 2 })',
    "itx.ai.run( 'x' , {b:1, a:2} )",
  ])
    expect((await ruleAt(ctx, spelling))?.target).toBe("itx.builtins.whoami");
  expect(await ruleAt(ctx, "not an expression at all")).toBeNull();
});

// edge#5 — BUG (fixed): `rewriteRules.list()` listed the platform rows under a bare `itx` override,
// which claims every call before a platform row could — an effective table that contradicted
// `resolve`. FIX: no platform rows while a bare `itx` row stands.
test("edge#5: under a whole-context override the effective table shows no platform rows", async () => {
  const ctx = "prj_round2_list_under_override";
  const s = stub(ctx);
  const list = () =>
    s.invoke(["itx", "builtins", "rewriteRules", ["list"]]) as Promise<
      { match: string; origin: string }[]
    >;
  expect((await list()).some((row) => row.origin === "platform")).toBe(true);
  await s.append(rewriteRuleConfiguredEvent("itx", "itx.builtins.rpcStubs.get('x')"));
  const rows = await list();
  expect(rows.filter((row) => row.origin === "platform")).toEqual([]);
  expect(rows.map((row) => row.match)).toEqual(["itx"]);
  // and the override's removal brings them back
  await s.append(rewriteRuleConfiguredEvent("itx", "itx.builtins"));
  expect((await list()).some((row) => row.origin === "platform")).toBe(true);
});
