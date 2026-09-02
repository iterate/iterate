// review-bugs-edge-side.e2e.test.ts — RED PROOFS from the 2026-09-02 edge/rpc-stub bug hunt
// (docs/reviews/2026-09-02-bugs-edge-side.md). These are the findings that need the WHOLE worker:
// the edge verbs (`provide` / `subscribe`, src/iterate-context.ts), the session teardown
// (src/session.ts) and the DO's last-pager-close un-set, seen through the public doors a client
// has. Every test is `test.fails` — the house convention for a known-red proof, so the lane
// stays green; the comment block above each one is the whole finding.

import { expect, test } from "vitest";
import {
  append,
  codeOf,
  freshCtx,
  openItx,
  presence,
  rejection,
  rpcStubRewriteRuleMatches,
  sleep,
  subscriptions,
} from "./support/client.ts";
import { Tools } from "./support/targets.ts";

// BUG: `subscribe`'s handle is a silent NO-OP whenever the target is the ARRAY spelling of an
//      expression whose second step is `rpcStubs` — the row can never be removed by disposing it.
// WHY: iterate-context.ts:278 decides what the handle must undo with
//      `Array.isArray(target) && target[1] === "rpcStubs"`, meaning "we lent this callback under
//      subscription:<name>". But that predicate is also true for a caller-supplied EXPRESSION that
//      merely NAMES the registry (`["itx","rpcStubs",["get","cam"]]` — subscribing an
//      already-provided stub). Nothing was lent under `subscription:<name>`, so the handle's
//      `sessionTeardown.dispose(key)` finds no entry and does nothing, and the `target: null`
//      append the expression branch would have made is skipped. The STRING spelling of the exact
//      same target (`"itx.rpcStubs.get('cam')"`) is not an array, so it behaves correctly — two
//      codec halves, two behaviours, where the codec promises "either works wherever one works".
// EXPECTED: disposing a SubscriptionHandle removes its row for every target that is an expression,
//      in either codec half — only a callback THIS call lent is un-set by closing its pager.
test.fails("subscribe: disposing the handle of a row whose target is the ARRAY spelling of itx.rpcStubs.get(...) removes nothing — the row leaks", async () => {
  // CONTROL — the STRING half of the very same target: dispose removes the row.
  const control = openItx(freshCtx("subrow-string"));
  const controlHandle = await control.subscribe({
    name: "viaString",
    target: "itx.rpcStubs.get('cam')",
  });
  expect((await subscriptions(control)).map((r: any) => r.name)).toEqual(["viaString"]);
  controlHandle[Symbol.dispose]();
  await sleep(800);
  expect(await subscriptions(control)).toEqual([]);

  // THE BUG — the STRUCTURED half of the same target: dispose is a no-op, the row stays forever.
  const itx = openItx(freshCtx("subrow-array"));
  const handle = await itx.subscribe({
    name: "viaArray",
    target: ["itx", "rpcStubs", ["get", "cam"]],
  });
  expect((await subscriptions(itx)).map((r: any) => r.name)).toEqual(["viaArray"]);
  handle[Symbol.dispose]();
  await sleep(800);
  expect(await subscriptions(itx)).toEqual([]);
});

// BUG: a `subscribe` whose append the DO REFUSES (a paused stream) still leaves the client's
//      callback lent — the pager stays open and `itx.rpcStubs.list()` reports a stub under
//      `subscription:<name>` that no row and no rule names, for the session's whole life.
// WHY: iterate-context.ts:261-276 lends FIRST (`lendRpcStubOverPager` + `sessionTeardown.add`) and
//      appends second, with no try/catch around the append. `provide` has exactly that guard
//      (iterate-context.ts:229-236, "The DO refused the rule (STREAM_PAUSED): recall the lend, or a
//      stub nothing names would linger for the session") — `subscribe`, its twin one layer up, never
//      got it.
// EXPECTED: a refused subscribe recalls what it lent before it propagates the refusal, exactly as
//      `provide` does — presence must be identical before and after a call that failed.
test.fails("subscribe: an append the DO refuses (paused stream) leaves the callback lent — presence keeps a stub nothing names", async () => {
  const itx = openItx(freshCtx("paused-subscribe"));
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "review" } });

  // CONTROL — `provide` refused the same way recalls its lend: presence is clean.
  const provideError = await rejection(
    itx.provide("itx.refused", new Tools("refused")),
    "provide on a paused stream",
  );
  expect(codeOf(provideError)).toBe("STREAM_PAUSED");
  await sleep(600);
  expect(await presence(itx)).toEqual([]);

  // THE BUG — the same refusal through `subscribe` strands the lent callback.
  const subscribeError = await rejection(
    itx.subscribe({ name: "leaky", target: () => undefined }),
    "subscribe on a paused stream",
  );
  expect(codeOf(subscribeError)).toBe("STREAM_PAUSED");
  await sleep(600);
  expect(await presence(itx)).toEqual([]);
});

// BUG: an EXPRESSION rule's session-scoped undo clobbers a LIVE provider's rule configured LATER at
//      the same match — the provider's stub stays lent and listed in presence while its match has
//      gone default-deny, and the provider is never told.
// WHY: `provide(match, expression)` hands back a handle whose undo is an unconditional
//      `append(rewriteRuleConfiguredEvent(match, null))` (iterate-context.ts:207-209). The live-stub
//      branch is deliberately NOT written that way — its comment (iterate-context.ts:225-227) says
//      the un-set is left to the DO's last-pager-close "so a late-dying old session cannot clobber
//      the new one's rule". The expression branch has no such protection, so a stale session's
//      dispose (or its socket closing) deletes a rule it did not write, and the DO's own protection
//      never runs because no pager closed.
// EXPECTED: the same guarantee both branches claim to share — an undo un-sets the rule it wrote and
//      leaves a rule someone else has since configured at that match alone.
test.fails("provide: an expression rule's undo un-sets a LIVE provider's rule configured later at the same match", async () => {
  const ctx = freshCtx("clobbered-rule");
  const observer = openItx(ctx);

  // Session A names the match with a pure-data rule.
  const expressionHandle = await openItx(ctx).provide("itx.m", "itx.kv");
  // Session B then takes the match over with a LIVE stub (the map holds one rule per match).
  await openItx(ctx).provide("itx.m", new Tools("live"));
  await sleep(400);
  expect(await observer.invoke("itx.m.hello()")).toBe("hello-from-live");

  // Session A lets go of a rule that is no longer its own.
  expressionHandle[Symbol.dispose]();
  await sleep(1_000);

  // B's stub is still lent and still listed — but its match is gone, so every call is default-deny.
  expect(await presence(observer)).toContain("itx.m");
  expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.m");
  expect(await observer.invoke("itx.m.hello()")).toBe("hello-from-live");
});

// BUG: replacing a LIVE target with an EXPRESSION target at the same match/name never recalls the
//      stub the live target lent — the pager stays open for the session's life and
//      `itx.rpcStubs.list()` (PRESENCE, the physical truth) keeps reporting a stub nothing names.
// WHY: both verbs recall the incumbent lend ONLY on the `null` branch —
//      `provide` at iterate-context.ts:200-204 and `subscribe` at iterate-context.ts:277. The
//      expression branch of each returns before ever touching `#sessionTeardown`, and the DO cannot
//      help: its last-pager-close un-set only fires when a pager CLOSES, and nothing closed this one.
// EXPECTED: whatever this session lent under the key stops being lent the moment the key stops
//      meaning it — an expression target replaces a live one exactly as `null` does.
test.fails("provide/subscribe: replacing a live target with an EXPRESSION target leaves the lend open — presence reports a stub nothing names", async () => {
  const itx = openItx(freshCtx("swap-to-expression"));

  await itx.provide("itx.p", new Tools("live"));
  await sleep(400);
  expect(await presence(itx)).toEqual(["itx.p"]);
  await itx.provide("itx.p", "itx.kv"); // the match now means a built-in, not the stub
  await sleep(800);
  expect(await presence(itx)).toEqual([]);

  const subscribed = await itx.subscribe({ name: "swap", target: () => undefined });
  await sleep(400);
  expect(await presence(itx)).toEqual(["subscription:swap"]);
  await itx.subscribe({ name: "swap", target: "itx.kv.get" }); // same name, an expression target
  await sleep(800);
  expect(await presence(itx)).toEqual([]);
  void subscribed;
});
