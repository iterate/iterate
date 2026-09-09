// __workers-tests__/do-doors.test.ts — the IterateContextDurableObject's Workers-RPC doors,
// pinned at zero distance (the workers lane is the only one that can BOTH call the DO verbs raw —
// no capnweb edge reducing the returns away — AND inspect the DO's own storage via
// runInDurableObject). The DO has exactly these doors: the STREAM (`append`, `read` — a wait is
// the built-in `itx.waitForEvent`, through `invoke`), the ONE dispatch door (`invoke`), native `fetch` (the pager door, the
// fetch-upgrade leg, the itx-expression fetch lane, egress) and the rpc-stub plumbing
// (`lendRpcStub`, `rpcStubTransportState`; the pager attach IS the upgrade). There are NO configuration
// verbs: every change to a context is an appended event, so a Workers-RPC caller configures a
// rewrite rule exactly as the edge's `provide` does — `append(rewriteRuleConfiguredEvent(match,
// target))` (context/itx-expression-rewriting.ts) — and a subscription with
// `append(subscriptionConfiguredEvent(…))` (stream/subscriptions.ts). The pins:
//
//   • the QUIET CLOCK's reason to exist: a probe (`itx.facets.get('core').snapshot()`) on a
//     never-touched ctx MATERIALIZES it (the constructor's `Stream.appendCreatedAndWokenEvents()`
//     writes created + woken before any door opens) yet arms NO alarm — #recordActivityForQuietClock
//     arms only when there is something to quiesce (a live facet, a borrowed rpc stub); only
//     storage.getAlarm() can see that (the e2e lane pins the records but cannot read the alarm);
//   • the doors themselves: the four deleted configuration verbs are gone; the rewrite-rule EVENT
//     is canonicalized by its builder (a Workers-RPC caller bypasses the edge); and a table row is
//     `{ match, target }` keyed by the canonical match and NOTHING else — no lane, no offset
//     identity (HOW a target is served is never written on a rule: the delivery loop decides by
//     evaluating a subscription's own target, subscription-delivery.ts);
//   • the table is a MAP: a re-set at the same match REPLACES (nothing is "beneath"), `null`
//     DELETES, a second `null` is a benign no-op — and every set or un-set is exactly ONE event,
//     never deduped against the current row;
//   • un-setting a rule is pure data and never touches a transport: the lent stub stays in
//     `itx.rpcStubs` (its pager socket in the census), reachable THROUGH the registry, while the
//     un-set match answers NO_ITX_EXPRESSION_MATCH; disposing the provide HANDLE is the other half
//     — it recalls the stub (presence shrinks) AND un-sets the rule it was provided with.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { parse, print, type ItxExpression } from "../src/context/expression.ts";
import {
  rewriteRuleConfiguredEvent,
  rewriteRuleRemovedEvent,
} from "../src/context/itx-expression-rewriting.ts";
import { subscriptionConfiguredEvent } from "../src/stream/subscriptions.ts";
import { openSession, stub, until } from "./support.ts";

/** One rewrite-rule row as the core snapshot serializes it (the rules are `core` state — a RECORD
 *  by canonical match; both halves are the parsed ItxExpression, so `print` them to compare against
 *  the strings the event was built from). */
type RewriteRuleRow = { match: ItxExpression; target: ItxExpression };
const rewriteRulesOf = async (ctx: string): Promise<Record<string, RewriteRuleRow>> =>
  (
    (await stub(ctx).invoke("itx.facets.get('core').snapshot()")) as {
      state: { itxExpressionRewriteRules: Record<string, RewriteRuleRow> };
    }
  ).state.itxExpressionRewriteRules;

/** The `itx/rewrite-rule-configured` rows of the durable log — one per set or un-set, no dedupe. */
const rewriteRuleEventCount = async (ctx: string): Promise<number> =>
  (
    (await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: { type: string }[] }
  ).events.filter((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured").length;

/** The DO's in-memory socket census (a DO-only verb — physical facts, never event-derivable). */
const rpcStubPagersOf = async (ctx: string): Promise<number> =>
  ((await stub(ctx).rpcStubTransportState()) as { rpcStubPagers: number }).rpcStubPagers;

/** The code of a call that MUST reject — awaited over the capnweb session, not the raw DO stub: a
 *  rejecting DO call through the vitest-plugin's RPC bridge is echoed by workerd as an "Uncaught (in
 *  promise)" line even when caught; over /api the CODED error simply crosses the hop. */
async function deniedCode(itx: any, call: string): Promise<string | undefined> {
  try {
    await itx.invoke(call);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

/** The client rpc stub under test — a method receiver, so the registry reach is the documented
 *  pipelinable spelling `itx.rpcStubs.get('<rpcStubKey>').ping()`. */
class Alive extends RpcTarget {
  ping(): string {
    return "alive";
  }
}

test("a core-snapshot probe on a NEVER-TOUCHED ctx materializes it (created, woken, config subscription) and arms the config-worker delivery alarm — EVERY stream subscribes itx.cd('/').worker", async () => {
  await runInDurableObject(stub("prj_doors_virginprobe"), async (instance, state) => {
    // ANY door materializes a context: the constructor writes the birth certificate, the wake record,
    // AND the `config` subscription — every stream subscribes the "/" context's config worker (the
    // apps/os funnel). That subscription is a cursor delivery, so it arms an alarm from birth; a DOWN
    // config worker cannot wake-loop forever (the self-wake breaker halts it — stream.ts).
    const snap = (await instance.invoke("itx.facets.get('core').snapshot()")) as {
      offset: number;
      state: { projectId?: string; path?: string; createdAt?: string; incarnation?: number };
    };
    expect(snap.state).toMatchObject({
      projectId: "prj_doors_virginprobe",
      path: "/",
      incarnation: 1,
    });
    expect(typeof snap.state.createdAt).toBe("string");
    expect(snap.offset).toBe(4); // reduced through created, woken and the config subscription
    expect(await state.storage.getAlarm()).not.toBeNull(); // the config subscription's delivery arms it
    expect((await instance.read(0)).events.map((e) => [e.type, e.offset])).toEqual([
      ["events.iterate.com/stream/created", 1],
      ["events.iterate.com/stream/woken", 2],
      ["events.iterate.com/stream/subscription-configured", 4], // the config subscription
    ]);
    expect(
      Number(
        state.storage.sql.exec("SELECT value FROM stream_meta WHERE key = 'incarnation'").one()
          .value,
      ),
    ).toBe(1);
    // A plain append rides past the config subscription's own commit and the two live-state deltas
    // (the wake commit at 3, the config commit at 5) — offset 6.
    const [mark] = (await instance.append({ type: "mark" })) as unknown as { offset: number }[];
    expect(mark.offset).toBe(6);
    expect(await state.storage.getAlarm()).not.toBeNull(); // still armed — the config delivery
  });
});

test("the DO's doors are the stream, invoke, fetch and the rpc-stub plumbing — no configuration verbs; a rewrite rule is ONE appended event whose builder canonicalizes the match, and a table row is `{ match, target }`, nothing else", async () => {
  const ctx = "prj_doors_canonical";
  await runInDurableObject(stub(ctx), async (instance) => {
    const doors = instance as unknown as Record<string, unknown>;
    for (const gone of [
      "provideCapability",
      "revokeCapability",
      "configureSubscription",
      "removeSubscription",
      "attachRpcStubPager", // folded into the pager upgrade at `fetch` (key + the events that name it)
    ])
      expect(gone in doors).toBe(false);
    for (const door of [
      "append",
      "read",
      "invoke",
      "fetch",
      "lendRpcStub",
      "rpcStubTransportState",
    ])
      expect(typeof doors[door]).toBe("function");
  });
  // A Workers-RPC caller bypasses the edge, so the EVENT BUILDER must canonicalize on its own: a
  // non-canonical spelling (leading whitespace) lands the CANONICAL match with the target verbatim.
  // And the row carries no third kind of field — nothing about HOW a target is served is on a rule
  // (a live stub's rule is pure data naming the `itx.rpcStubs` registry; a subscription is its own
  // layer's event, not a rule).
  await stub(ctx).append(
    rewriteRuleConfiguredEvent(" itx.aliased.ghost", "itx.rpcStubs.get('itx.aliased.ghost')"),
  );
  const rules = await rewriteRulesOf(ctx);
  expect(Object.keys(rules)).toEqual(["itx.aliased.ghost"]); // keyed by the canonical match
  const row = rules["itx.aliased.ghost"]!;
  expect(print(row.match)).toBe("itx.aliased.ghost"); // stored CANONICAL — the one-canonicalizer rule
  expect(print(row.target)).toBe("itx.rpcStubs.get('itx.aliased.ghost')"); // the target, verbatim
  expect(Object.keys(row).sort()).toEqual(["match", "target"]); // and nothing else
});

test("the rule table is a MAP: a re-set at the same match REPLACES (one row, nothing beneath), `null` DELETES, a second `null` is a benign no-op — and every set or un-set is exactly ONE event, never deduped", async () => {
  const ctx = "prj_doors_map";
  const s = stub(ctx);
  await s.append(rewriteRuleConfiguredEvent("itx.alias", "itx.whoami"));
  expect(await s.invoke("itx.alias()")).toEqual({ projectId: ctx, path: "/" });
  // The same match set again: the row is replaced in place — one key, the new target, no stack.
  await s.append(rewriteRuleConfiguredEvent("itx.alias", "itx.rpcStubs.list"));
  expect(await s.invoke("itx.alias()")).toEqual([]);
  expect(Object.keys(await rewriteRulesOf(ctx))).toEqual(["itx.alias"]);
  expect(await rewriteRuleEventCount(ctx)).toBe(2); // one event per set — no dedupe against the current row
  // `null` deletes; nothing is "restored from beneath" — the first target went with the replace.
  await s.append(rewriteRuleConfiguredEvent("itx.alias", null));
  expect(await rewriteRulesOf(ctx)).toEqual({});
  // A second `null` lands as a row (the log is the log) and changes nothing — the reduce's no-op.
  await s.append(rewriteRuleConfiguredEvent("itx.alias", null));
  expect(await rewriteRulesOf(ctx)).toEqual({});
  expect(await rewriteRuleEventCount(ctx)).toBe(4);
});

test("un-setting a rule is pure data — the lent stub's transport is untouched: the census holds, the registry still lists the key, the match answers NO_ITX_EXPRESSION_MATCH, and the stub is still reachable THROUGH the registry", async () => {
  const ctx = "prj_doors_unsetlive";
  const s = stub(ctx);
  // A PHYSICAL stub: a capnweb session lends a client's rpc stub under `itx.livecap` (its pager socket is
  // one transport in the DO's census) with the pure-data rule `itx.livecap ⇒
  // itx.rpcStubs.get('itx.livecap')` configured alongside it.
  const itx = await (await openSession()).authenticate().projects.get(ctx);
  const provided = await itx.provide("itx.livecap", new Alive());
  expect(typeof provided[Symbol.dispose]).toBe("function"); // a DISPOSABLE handle — no offsets, no identities
  expect(await s.invoke("itx.livecap.ping()")).toBe("alive");
  const rpcStubPagersBefore = await rpcStubPagersOf(ctx);
  expect(rpcStubPagersBefore).toBe(1);

  // The rule un-set AT THE DO DOOR — the raw event, not the handle. The row pops; the transport is
  // NOT touched: the census is unchanged, the registry still lists the key, and only the RULE is
  // gone (default-deny at the match — NO_ITX_EXPRESSION_MATCH, not offline).
  await s.append(rewriteRuleConfiguredEvent("itx.livecap", null));
  expect(await rpcStubPagersOf(ctx)).toBe(rpcStubPagersBefore);
  expect(await s.invoke("itx.rpcStubs.list()")).toEqual(["itx.livecap"]);
  expect(await deniedCode(itx, "itx.livecap.ping()")).toBe("NO_ITX_EXPRESSION_MATCH");
  expect("itx.livecap" in (await rewriteRulesOf(ctx))).toBe(false);
  // …and the lent stub is still reachable THROUGH THE REGISTRY, rule or no rule.
  expect(await s.invoke("itx.rpcStubs.get('itx.livecap').ping()")).toBe("alive");

  // A NEW rule at the match brings the SAME stub back dotted — the rule was the only thing gone.
  await s.append(rewriteRuleConfiguredEvent("itx.livecap", "itx.rpcStubs.get('itx.livecap')"));
  expect(await itx.invoke("itx.livecap.ping()")).toBe("alive");
});

test("disposing the provide HANDLE is the other half: the stub is recalled — its pager leaves the census, presence shrinks — AND the rule it was provided with is un-set", async () => {
  const ctx = "prj_doors_disposehandle";
  const s = stub(ctx);
  const itx = await (await openSession()).authenticate().projects.get(ctx);
  const provided = await itx.provide("itx.doomed", new Alive());
  expect(await s.invoke("itx.doomed.ping()")).toBe("alive");
  expect(Object.keys(await rewriteRulesOf(ctx))).toEqual(["itx.doomed"]);
  expect(await rpcStubPagersOf(ctx)).toBe(1);

  provided[Symbol.dispose](); // the client lets go: capnweb releases the export, the edge recalls
  await until("the pager left the census", async () => (await rpcStubPagersOf(ctx)) === 0);
  await until("the rule was un-set", async () => !("itx.doomed" in (await rewriteRulesOf(ctx))));
  expect(await s.invoke("itx.rpcStubs.list()")).toEqual([]); // presence shrank
  expect(await deniedCode(itx, "itx.doomed.ping()")).toBe("NO_ITX_EXPRESSION_MATCH");
});

test("a PAUSED context survives an eviction: the constructor's birth-row replay is admitted while paused, so the next incarnation can take the resume (BORN RED: the pause check ran before the idempotency lookup, and a paused context could never be rebuilt)", async () => {
  const ctx = "prj_doors_paused_evict";
  const s = stub(ctx);
  await s.append({ type: "events.iterate.com/stream/paused", payload: { reason: "operator" } });
  await evictDurableObject(s);
  // The fresh incarnation's constructor replays `config` under its idempotency key — on a paused
  // stream. Then the resume lands like any other day.
  await stub(ctx).append({ type: "events.iterate.com/stream/resumed" });
  const page = (await stub(ctx).invoke(["itx", ["readEvents", 0, 50]])) as {
    events: { type: string }[];
  };
  expect(page.events.map((e) => e.type)).toContain("events.iterate.com/stream/resumed");
  const [afterResume] = (await stub(ctx).append({ type: "after-resume" })) as unknown as {
    type: string;
  }[];
  expect(afterResume.type).toBe("after-resume");
});

test("a handle's undo is a COMPARE-AND-SET decided in the reduce: a stale removal (naming the target or the offset the handle wrote) is a no-op against a replacement — there is no read-then-append window", async () => {
  const ctx = "prj_doors_undo_cas";
  const s = stub(ctx);
  // RULES: session A's row, replaced by session B's; A's undo names A's target and changes nothing.
  await s.append(rewriteRuleConfiguredEvent("itx.x", "itx.tab1"));
  await s.append(rewriteRuleConfiguredEvent("itx.x", "itx.tab2"));
  await s.append(rewriteRuleRemovedEvent("itx.x", parse("itx.tab1")));
  expect(print((await rewriteRulesOf(ctx))["itx.x"].target)).toBe("itx.tab2");
  await s.append(rewriteRuleRemovedEvent("itx.x", parse("itx.tab2"))); // B's own undo
  expect((await rewriteRulesOf(ctx))["itx.x"]).toBeUndefined();
  // SUBSCRIPTIONS: the row's identity is its configure offset.
  const [first] = (await s.append(
    subscriptionConfiguredEvent({ name: "digest", target: "itx.digest.processEventBatch" }),
  )) as unknown as { offset: number }[];
  const [second] = (await s.append(
    subscriptionConfiguredEvent({ name: "digest", target: "itx.digest.processEventBatch" }),
  )) as unknown as { offset: number }[];
  const row = async () =>
    (await s.invoke("itx.subscriptions.get('digest')")) as { configuredAtOffset: number } | null;
  await s.append(
    subscriptionConfiguredEvent({
      name: "digest",
      target: null,
      ifConfiguredAtOffset: first.offset,
    }),
  );
  expect((await row())?.configuredAtOffset).toBe(second.offset); // the replacement stands
  await s.append(
    subscriptionConfiguredEvent({
      name: "digest",
      target: null,
      ifConfiguredAtOffset: second.offset,
    }),
  );
  expect(await row()).toBeNull();
});
