// rpc-stubs-attach-carries-the-rule.e2e.test.ts — THE DO OWNS BOTH ENDS of a lent stub's rule (and of a
// live subscriber's row). The edge's `provide(match, stub)` / `subscribe({ target: fn })` build the
// event that names the key and hand it to the DO INSIDE the pager upgrade; the DO appends it in the
// same turn it accepts the pager (src/context/rpc-stub-directory.ts) and un-sets it when the key's
// last pager closes. So a provide is ONE edge→DO round trip, and the set and the un-set are decided
// on the same side, by the same physical fact.
//
// The observable: the ORDER of two events on the shared offset sequence. `rpc-stub/attached` (the
// ephemeral presence fact) is appended AFTER the events the attach carried — so the rule / the row
// has a LOWER offset than the key's `attached`. Under the old three-call dance (attach RPC, upgrade,
// then the edge's own append) `attached` came first: this file is red there and green here.
//
// And the refusal: a paused stream refuses the attach as a whole — no stub lent, no presence, no
// rule, no row — with the same STREAM_PAUSED code the append door speaks; after `stream/resumed`
// the same call lands.

import { expect, test } from "vitest";
import {
  append,
  codeOf,
  collector,
  freshCtx,
  openItx,
  presence,
  readAll,
  rejection,
  rpcStubRewriteRuleMatches,
  subscriptions,
  until,
} from "./support/client.ts";
import { Tools } from "./support/targets.ts";

const ATTACHED = "events.iterate.com/rpc-stub/attached";
const RULE_CONFIGURED = "events.iterate.com/itx/rewrite-rule-configured";
const SUBSCRIPTION_CONFIGURED = "events.iterate.com/stream/subscription-configured";

/** A live watcher of presence: the ephemeral `rpc-stub/attached` events, WITH their offsets. */
async function watchAttached(ctx: string) {
  const observer = openItx(ctx);
  const seen = collector();
  await observer.subscribe({ name: "presence-watch", target: seen.fn, consumes: [ATTACHED] });
  const attachedOffsetOf = (rpcStubKey: string): number | undefined =>
    seen.invocations
      .flatMap((i) => i.events)
      .find((e) => e.type === ATTACHED && e.payload?.rpcStubKey === rpcStubKey)?.offset;
  return { observer, attachedOffsetOf };
}

test("provide(match, stub): the rule is appended INSIDE the pager attach — its offset is below the key's rpc-stub/attached", async () => {
  const ctx = freshCtx("attach-rule");
  const { observer, attachedOffsetOf } = await watchAttached(ctx);

  await openItx(ctx).provide("itx.pinned", new Tools("pinned"));
  const attachedOffset = await until("itx.pinned attached seen by the watcher", () =>
    attachedOffsetOf("itx.pinned"),
  );
  const ruleEvent = (await readAll(observer)).find(
    (e) => e.type === RULE_CONFIGURED && e.payload?.match === "itx.pinned",
  );
  expect(ruleEvent?.payload.target).toBe("itx.rpcStubs.get('itx.pinned')");
  // THE PIN: the DO appended the rule while accepting the pager, before it announced presence.
  expect(ruleEvent.offset).toBeLessThan(attachedOffset);
  // And it all works: presence, the rule, a call through the match.
  expect(await presence(observer)).toContain("itx.pinned");
  expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.pinned");
  expect(await observer.invoke("itx.pinned.hello()")).toBe("hello-from-pinned");
});

test("subscribe({ target: fn }): the row is appended INSIDE the pager attach — its offset is below the key's rpc-stub/attached", async () => {
  const ctx = freshCtx("attach-row");
  const { observer, attachedOffsetOf } = await watchAttached(ctx);

  const deliveries = collector();
  await openItx(ctx).subscribe({ name: "live", target: deliveries.fn, consumes: ["mark"] });
  const attachedOffset = await until("subscription:live attached seen by the watcher", () =>
    attachedOffsetOf("subscription:live"),
  );
  const rowEvent = (await readAll(observer)).find(
    (e) => e.type === SUBSCRIPTION_CONFIGURED && e.payload?.name === "live",
  );
  expect(rowEvent?.payload.target).toBe("itx.rpcStubs.get('subscription:live')");
  expect(rowEvent.offset).toBeLessThan(attachedOffset);
  // The row delivers: a mark lands on the live callback through the pager the attach opened.
  await append(observer, { type: "mark", payload: { n: 1 } });
  await until("the mark delivered", () => deliveries.types().includes("mark"));
});

test("a paused stream refuses provide AND subscribe as a whole — nothing lent, no presence, no rule, no row — and after resume the same calls land", async () => {
  const ctx = freshCtx("attach-refused");
  const itx = openItx(ctx);
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "test" } });

  const provideError = await rejection(
    itx.provide("itx.refused", new Tools("refused")),
    "provide on a paused stream",
  );
  expect(codeOf(provideError)).toBe("STREAM_PAUSED");
  const subscribeError = await rejection(
    itx.subscribe({ name: "refused", target: () => undefined }),
    "subscribe on a paused stream",
  );
  expect(codeOf(subscribeError)).toBe("STREAM_PAUSED");
  expect(await presence(itx)).toEqual([]);
  expect(await rpcStubRewriteRuleMatches(itx)).toEqual([]);
  expect(await subscriptions(itx)).toEqual([]);
  expect((await readAll(itx)).filter((e) => e.type === RULE_CONFIGURED)).toEqual([]);

  await append(itx, { type: "events.iterate.com/stream/resumed" });
  await itx.provide("itx.refused", new Tools("resumed"));
  const marks = collector();
  await itx.subscribe({ name: "refused", target: marks.fn, consumes: ["mark"] });
  expect(await presence(itx)).toEqual(
    expect.arrayContaining(["itx.refused", "subscription:refused"]),
  );
  expect(await rpcStubRewriteRuleMatches(itx)).toEqual(["itx.refused"]);
  expect((await subscriptions(itx)).map((row) => row.name)).toEqual(["refused"]);
  expect(await itx.invoke("itx.refused.hello()")).toBe("hello-from-resumed");
  await append(itx, { type: "mark", payload: { n: 1 } });
  await until("the mark delivered after resume", () => marks.types().includes("mark"));
});
