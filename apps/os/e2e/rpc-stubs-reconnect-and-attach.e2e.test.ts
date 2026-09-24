// rpc-stubs-reconnect-and-attach.e2e.test.ts — RECONNECT AT THE SAME SPELLING, and THE ATTACH that
// carries the rule. An rpc-stub PROVIDER is ephemeral (its capnweb WebSocket terminates at a STATELESS
// `/api` worker), so a provider dropping is EXPECTED and the platform's answer is re-provide at the
// same match, not server durability (the dead-provider half — presence shrinks, the rule is un-set,
// the match is default-deny, a same-key re-provide replaces the transport — is
// rpc-stubs-lend-recall-and-offline.e2e). The DO owns BOTH ends of a lent stub's rule (and of a live
// subscriber's row): the edge's `provide(match, stub)` / `subscribe({ target: fn })` build the event
// that names the key and hand it to the DO INSIDE the pager upgrade, which appends it in the turn it
// accepts the pager (src/context/rpc-stubs.ts) and un-sets it when the key's last pager
// closes — one edge→DO round trip, the set and the un-set decided on one side. Pins:
//   • a live SUBSCRIBER re-subscribing under its name replaces the transport (ONE row, ONE more
//     configured event, the first callback physically unreachable); `subscribe({ name, target: null })`
//     drops the row and recalls the stub — no callback under that name receives anything afterwards
//   • THE LEASE IS THE HANDLE: disposing a STALE provide handle leaves its replacement serving; an
//     EXPRESSION handle disposed after a live provider took its match over un-sets nothing
//   • RED (`createFailing`): two sessions providing the IDENTICAL rule share one identity — disposing the
//     first removes the second's row
//   • the rule / the row is appended INSIDE the pager attach: its offset is BELOW the key's ephemeral
//     `rpc-stub/attached` (the presence fact)
//   • a paused stream's refusal of a provide or a subscribe crosses /api CODED (STREAM_PAUSED); after
//     resume the same calls land (the attach's atomicity at the DO's door — 409 + code, no socket, no
//     presence, no rule — is __workers-tests__/rpc-stub-pager-attach.test.ts)

import { expect, test } from "vitest";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { errorCode } from "iterate/next/lib";
import {
  collector,
  freshCtx,
  openItx,
  presence,
  readAll,
  rejection,
  rpcStubRewriteRuleMatches,
  ruleMatchAtRest,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { Tools } from "./support/targets.ts";

// ── reconnect at the same spelling ──

// The reconnect one layer up: a LIVE SUBSCRIBER is a stub lent under
// `subscription:<name>` plus one subscription row naming it. Re-subscribing the same name
// re-lends under the same key — the session disposes the first relay (its transport is REPLACED, the
// first callback physically unreachable) — and appends ONE more subscription-configured (same name
// REPLACES the row; there is no shadow stack and no dedupe). `subscribe({ name, target: null })`
// drops the one row and recalls this session's stub: no callback under that name receives anything
// afterwards.
test("a live subscriber re-subscribes under the same name — the transport is replaced (one row, one more event); a null target stops delivery for good", async () => {
  const itx = openItx(freshCtx("resub"));
  await itx.append({ type: "seed" });
  const rowsNamed = async (name: string): Promise<unknown[]> =>
    (await subscriptions(itx)).filter((r: { name: string }) => r.name === name);

  // ── CONTROL: a single live subscribe delivers; subscribe({ name, target: null }) stops it ──
  let ctrl = 0;
  await itx.subscribe({
    name: "control",
    consumes: ["ctl"],
    target: (events: unknown[]) => {
      ctrl += events.length;
    },
  });
  await itx.append({ type: "ctl", payload: { n: 1 } });
  await until("control delivered", () => ctrl === 1);
  await itx.subscribe({ name: "control", target: null });
  expect(await rowsNamed("control")).toHaveLength(0);
  await itx.append({ type: "ctl", payload: { n: 2 } });
  await sleep(1500);
  expect(ctrl).toBe(1); // NO delivery after the removal

  // ── re-subscribe the SAME name with a second callback ──
  let cb1 = 0;
  let cb2 = 0;
  await itx.subscribe({
    name: "s",
    consumes: ["mark"],
    target: (events: unknown[]) => {
      cb1 += events.length;
    },
  });
  const logBefore = await itx.readEvents(0, 500);
  await itx.subscribe({
    name: "s", // the client's model: this REPLACES cb1
    consumes: ["mark"],
    target: (events: unknown[]) => {
      cb2 += events.length;
    },
  });
  // the replacing row appended ONE event, the table holds ONE row named s, and the key is present
  const logAfter = await itx.readEvents(0, 500);
  expect(logAfter.events.length).toBe(logBefore.events.length + 1);
  expect(await rowsNamed("s")).toHaveLength(1);
  expect(await presence(itx)).toContain("subscription:s");

  await itx.append({ type: "mark", payload: { n: 1 } });
  await until("cb2 delivered", () => cb2 === 1);
  await sleep(1000);
  expect(cb1).toBe(0); // only the newest callback is reachable — cb1's transport was replaced

  // ── null target once: the row and this session's stub are gone; nobody under s hears the next mark ──
  await itx.subscribe({ name: "s", target: null });
  expect(await rowsNamed("s")).toHaveLength(0);
  await until("stub closed", async () => !(await presence(itx)).includes("subscription:s"));
  await itx.append({ type: "mark", payload: { n: 2 } });
  await sleep(1500);
  expect(cb1).toBe(0);
  expect(cb2).toBe(1);
});

// THE LEASE IS THE HANDLE: a provide handle's dispose tears down what IT set up and nothing else. Re-
// provide at the same match (the reconnect) and then dispose the OLD handle: the new pager keeps
// serving. The same for an EXPRESSION rule's handle whose match a live provider has since taken over:
// its undo un-sets only the rule it wrote (compare-and-set on the row), never the newer one. (The
// control — an expression handle removing its OWN rule — is rewrite-rules.e2e's red pin.)
test("disposing a STALE provide handle leaves its replacement serving; only the live handle's dispose un-sets the match", async () => {
  const ctx = freshCtx("stale-lease");
  const itx = openItx(ctx);
  const first = await itx.provide("itx.tool", new Tools("first"));
  const second = await itx.provide("itx.tool", new Tools("second"));
  await until(
    "the reconnect serves",
    async () => (await itx.invoke("itx.tool.echo('x')")) === "echo-second:x" || undefined,
  );
  first[Symbol.dispose](); // stale — must touch nothing
  await sleep(300);
  expect(await itx.invoke("itx.tool.echo('y')")).toBe("echo-second:y");
  second[Symbol.dispose]();
  const denied = await until("the un-set landed", async () => {
    const e = await rejection(itx.invoke("itx.tool.echo('z')"));
    return errorCode(e) === "RPC_STUB_OFFLINE" ? undefined : e; // the recall's window — keep waiting
  });
  expect(errorCode(denied)).toBe("NO_ITX_EXPRESSION_MATCH");
});

test("an EXPRESSION rule's handle disposed after a live provider took its match over un-sets nothing — the live rule and its stub keep serving", async () => {
  const ctx = freshCtx("stale-expression-lease");
  const observer = openItx(ctx);
  const expressionHandle = await openItx(ctx).provide("itx.m", "itx.kv"); // session A: a pure-data rule
  await openItx(ctx).provide("itx.m", new Tools("live")); // session B takes the match over (one rule per match)
  await until(
    "the live stub serves",
    async () => (await observer.invoke("itx.m.echo('a')")) === "echo-live:a" || undefined,
  );
  expressionHandle[Symbol.dispose](); // A lets go of a rule that is no longer its own
  await sleep(1_000);
  expect(await presence(observer)).toContain("itx.m");
  expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.m");
  expect(await observer.invoke("itx.m.echo('b')")).toBe("echo-live:b");
});

// RED (a `createFailing` pin — a known defect, too costly to fix now): an EXPRESSION handle's undo compares the
// row's TARGET, not the handle's own generation, so two sessions providing the IDENTICAL rule share
// one identity — disposing the first removes the second's row. The fix is a per-configure generation
// compared inside ONE DO commit — a new mechanism.
createFailing(
  test,
  /the second session's identical rule should outlive the first handle: expected null/,
  {
    timeoutMs: 60_000,
    retries: process.env.CI ? E2E_CI_RETRIES : 0,
  },
)(
  "an EXPRESSION handle disposed after another session provided the IDENTICAL rule leaves that session's row standing",
  async () => {
    const ctx = freshCtx("identical-expression-handles");
    const first = await openItx(ctx).provide("itx.same", "itx.builtins.whoami");
    await openItx(ctx).provide("itx.same", "itx.builtins.whoami"); // the second session, the same rule
    first[Symbol.dispose]();
    await sleep(1_000);
    expect(
      await openItx(ctx).rewriteRules.get("itx.same"),
      "the second session's identical rule should outlive the first handle",
    ).toMatchObject({
      target: "itx.builtins.whoami",
      context: "/",
    });
  },
);

// ── the attach carries the rule: the ORDER of two events on the shared offset sequence.
// `rpc-stub/attached` (the ephemeral presence fact) is appended AFTER the events the attach carried,
// so the rule / the row has a LOWER offset than the key's `attached` ──

const ATTACHED = "events.iterate.com/rpc-stub/attached";

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
    (e) =>
      e.type === "events.iterate.com/itx/rewrite-rule-configured" &&
      ruleMatchAtRest(e) === "itx.pinned",
  );
  expect(ruleEvent?.payload.target).toEqual(["itx", "builtins", "rpcStubs", ["get", "itx.pinned"]]);
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
    (e) =>
      e.type === "events.iterate.com/stream/subscription-configured" && e.payload?.name === "live",
  );
  expect(rowEvent?.payload.target).toEqual([
    "itx",
    "builtins",
    "rpcStubs",
    ["get", "subscription:live"],
  ]);
  expect(rowEvent.offset).toBeLessThan(attachedOffset);
  // The row delivers: a mark lands on the live callback through the pager the attach opened.
  await observer.append({ type: "mark", payload: { n: 1 } });
  await until("the mark delivered", () => deliveries.types().includes("mark"));
});

test("a paused stream's refusal of a provide or a subscribe crosses /api CODED — STREAM_PAUSED on the error — and after resume the same calls land", async () => {
  // The edge turns the refused pager upgrade's answer (a 409 whose JSON body carries the code) into
  // the coded capnweb error a client classifies by; the attach itself is pinned at the DO's door.
  const ctx = freshCtx("attach-refused");
  const itx = openItx(ctx);
  await itx.append({ type: "events.iterate.com/stream/paused", payload: { reason: "test" } });

  const provideError = await rejection(
    itx.provide("itx.refused", new Tools("refused")),
    "provide on a paused stream",
  );
  expect(errorCode(provideError)).toBe("STREAM_PAUSED");
  const subscribeError = await rejection(
    itx.subscribe({ name: "refused", target: () => undefined }),
    "subscribe on a paused stream",
  );
  expect(errorCode(subscribeError)).toBe("STREAM_PAUSED");

  await itx.append({ type: "events.iterate.com/stream/resumed" });
  await itx.provide("itx.refused", new Tools("resumed"));
  const marks = collector();
  await itx.subscribe({ name: "refused", target: marks.fn, consumes: ["mark"] });
  expect(await itx.invoke("itx.refused.hello()")).toBe("hello-from-resumed");
  await itx.append({ type: "mark", payload: { n: 1 } });
  await until("the mark delivered after resume", () => marks.types().includes("mark"));
});
