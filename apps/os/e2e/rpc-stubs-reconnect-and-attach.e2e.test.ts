// rpc-stubs-reconnect-and-attach.e2e.test.ts — RECONNECT AT THE SAME SPELLING, and THE ATTACH that
// carries the effective rule. An rpc-stub PROVIDER is ephemeral (its capnweb WebSocket terminates at
// a STATELESS `/api` worker), so a provider dropping is expected and the platform's answer is
// re-provide at the same match. The pager attachment projects the live rule or subscription while it
// is open. Pins:
//   • a live SUBSCRIBER re-subscribing under its name replaces the transport; the first callback is
//     physically unreachable; `subscribe({ name, target: null })` drops the attachment
//   • THE LEASE IS THE HANDLE: disposing a STALE provide handle leaves its replacement serving; an
//     EXPRESSION handle disposed after a live provider took its match over un-sets nothing
//   • RED (`createFailing`): two sessions providing the IDENTICAL rule share one identity — disposing the
//     first removes the second's row
//   • a paused stream accepts a write-less live attachment, while durable configuration remains
//     refused until resume

import { expect, test } from "vitest";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { errorCode } from "iterate/lib";
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

// The reconnect one layer up: a LIVE SUBSCRIBER is a stub lent under `subscription:<name>` plus a
// projected subscription row. Re-subscribing replaces its transport. `target: null` drops the
// attachment, so no callback under that name receives anything afterwards.
test("a live subscriber re-subscribes under the same name; a null target stops delivery for good", async () => {
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
  await itx.subscribe({
    name: "s", // the client's model: this REPLACES cb1
    consumes: ["mark"],
    target: (events: unknown[]) => {
      cb2 += events.length;
    },
  });
  // The projected table holds one row named s and the key is present.
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
  await removalCommitted(observer, "itx.m");
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
    const observer = openItx(ctx);
    const first = await openItx(ctx).provide("itx.same", "itx.builtins.whoami");
    await openItx(ctx).provide("itx.same", "itx.builtins.whoami"); // the second session, the same rule
    first[Symbol.dispose]();
    await removalCommitted(observer, "itx.same");
    expect(
      await observer.rewriteRules.get("itx.same"),
      "the second session's identical rule should outlive the first handle",
    ).toMatchObject({
      target: "itx.builtins.whoami",
      context: "/",
    });
  },
);

test("provide(match, stub) projects its effective rule and presence", async () => {
  const ctx = freshCtx("attach-rule");
  const observer = openItx(ctx);

  await openItx(ctx).provide("itx.pinned", new Tools("pinned"));
  await until("itx.pinned is present", async () =>
    (await presence(observer)).includes("itx.pinned"),
  );
  expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.pinned");
  expect(await observer.invoke("itx.pinned.hello()")).toBe("hello-from-pinned");
});

test("subscribe({ target: fn }) projects its row and delivers through the pager", async () => {
  const ctx = freshCtx("attach-row");
  const observer = openItx(ctx);

  const deliveries = collector();
  await openItx(ctx).subscribe({ name: "live", target: deliveries.fn, consumes: ["mark"] });
  await until("subscription:live is present", async () =>
    (await presence(observer)).includes("subscription:live"),
  );
  expect((await subscriptions(observer)).map((row) => row.name)).toContain("live");
  await observer.append({ type: "mark", payload: { n: 1 } });
  await until("the mark delivered", () => deliveries.types().includes("mark"));
});

test("a paused stream accepts live attachments but refuses durable configuration; delivery begins after resume", async () => {
  const ctx = freshCtx("attach-refused");
  const itx = openItx(ctx);
  await itx.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });

  const marks = collector();
  await itx.provide("itx.refused", new Tools("resumed"));
  await itx.subscribe({ name: "refused", target: marks.fn, consumes: ["mark"] });
  await until("the live provider and callback are present", async () => {
    const attached = await presence(itx);
    return attached.includes("itx.refused") && attached.includes("subscription:refused");
  });
  expect(await rpcStubRewriteRuleMatches(itx)).toContain("itx.refused");
  expect((await subscriptions(itx)).map((row) => row.name)).toContain("refused");

  const configError = await rejection(
    itx.provide("itx.durable", "itx.kv"),
    "durable configuration on a paused stream",
  );
  expect(errorCode(configError)).toBe("STREAM_PAUSED");

  await itx.append({ type: "events.iterate.com/itx/resumed" });
  expect(await itx.invoke("itx.refused.hello()")).toBe("hello-from-resumed");
  await itx.append({ type: "mark", payload: { n: 1 } });
  await until("the mark delivered after resume", () => marks.types().includes("mark"));
});

/** An EXPRESSION handle's dispose is fire-and-forget: the client's release reaches /api, whose undo
 *  appends the removal (`target: null` at the match) in the background (src/iterate-context.ts
 *  `#removeRuleInBackground`). A row that judges what the removal did waits for it to commit. */
async function removalCommitted(itx: any, match: string): Promise<void> {
  await until(`the handle's removal of ${match} committed`, async () =>
    (await readAll(itx)).some(
      (e) =>
        e.type === "events.iterate.com/itx/rewrite-rule-configured" &&
        ruleMatchAtRest(e) === match &&
        e.payload.target === null,
    ),
  );
}
