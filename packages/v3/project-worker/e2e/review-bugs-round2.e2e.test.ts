// review-bugs-round2.e2e.test.ts — the proofs of the 2026-09-04 round-2 bug hunt that need the WHOLE
// worker: two sessions, the proxy's verbs, the DO's last-pager-close un-set, the fetch lane
// (docs/reviews/2026-09-04-round2-bugs-do-side.md and -edge-side.md). Every test is titled
// `<report>#<n>`; `test.fails` is the house convention for a known-red proof, and flipping it back to
// `test` is how a fix is proved. Each was run RED first.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import {
  append,
  codeOf,
  expressionUrl,
  freshCtx,
  openItx,
  rejection,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

// do-side#1 — BUG (fixed): when a lent stub died, the DO resolved each row against the LIVE table
// while its own appends changed it — a user's alias to the shadowed root was deleted as collateral
// in one configuration order and kept in the other. FIX: decided against a frozen table, order-free.
for (const order of ["alias first", "stub first"] as const)
  test(`do-side#1 (${order}): an alias to a shadowed root survives the shadow's stub dying`, async () => {
    const ctx = freshCtx("alias-survives");
    const itx = openItx(ctx);
    const real = await itx.whoami();
    const stubSession = session();
    const stubItx = stubSession.authenticate().projects.get(ctx);
    const alias = () => itx.provide("itx.me", "itx.whoami");
    const fake = () => stubItx.provide("itx.whoami", () => "the fake");
    if (order === "alias first") (await alias(), await fake());
    else (await fake(), await alias());
    expect(await itx.me()).toBe("the fake");

    stubSession[Symbol.dispose]();
    await until("the real whoami is back", async () => {
      const row = await itx.rewriteRules.get("itx.whoami");
      return row?.origin === "platform" ? row : undefined;
    });
    expect(await itx.rewriteRules.get("itx.me")).toEqual({
      match: "itx.me",
      target: "itx.whoami",
      origin: "context",
    });
    expect((await itx.rewriteRules.resolve("itx.me()")).at(-1)).toBe("itx.builtins.whoami()");
    expect(await itx.me()).toEqual(real);
  });

// do-side#6 — BUG (fixed): a whole-context override naming its OWN context (`itx ⇒ itx.builtins.cd('/x')`
// at `/x`) spun across hops — every hop a fresh resolve, so the depth budget never saw it — and the
// `cd` bypass deletion had widened it to append/readEvents. FIX: refused at the proxy, where the path
// is known.
test("do-side#6: a whole-context override naming its own context is refused", async () => {
  const itx = openItx(freshCtx("own-context-override")).cd("/x");
  for (const target of [
    "itx.builtins.cd('/x')",
    "itx.cd('/x')",
    "itx.builtins.cd('.')",
    "itx.cd('../x')",
  ]) {
    const refused = await rejection(itx.provide("itx", target));
    expect(refused.message).toMatch(/own context/);
  }
  // a sibling is fine
  const handle = await itx.provide("itx", "itx.builtins.cd('/y')");
  handle[Symbol.dispose]();
});

// edge#2 — BUG (fixed): `subscribe`'s expression handle un-set whatever row bore the name at dispose
// time — a later same-name subscribe (documented: "same name REPLACES") lost its row when the stale
// handle was disposed or its session ended, and when the replacement HOSTED a facet the DO deleted
// the facet and its storage. FIX: the undo is compare-and-set on the row's configuredAtOffset.
test("edge#2: a stale subscribe handle's dispose leaves a later same-name row, and the facet it hosts, alone", async () => {
  const ctx = freshCtx("stale-subscribe-handle");
  const a = openItx(ctx);
  const b = openItx(ctx);
  const stale = await a.subscribe({ name: "p", target: "itx.kv.get" });
  await b.subscribe({
    name: "p",
    target: [
      "itx",
      "facets",
      ["get", "p", { source: SOURCES.tally, className: "TallyDurableObject" }],
      "processEventBatch",
    ],
  });
  await append(b, { type: "events.iterate.com/chat/message", payload: { text: "hi" } });
  await until("the facet reduced the log", () => b.facets.get("p").snapshot());

  stale[Symbol.dispose]();
  await sleep(800);
  expect((await subscriptions(b)).map((row: { name: string }) => row.name)).toEqual(["p"]);
  expect(await b.facets.get("p").snapshot()).toBeDefined();
});

// edge#8 (non-Latin1 in the fetch-lane header) is NOT a bug on workerd: `itx.workers.get({ …, props:
// { greeting: '日本' } }).fetch` through `/expression` and through a session's terminal fetch answered
// 200 on the unfixed tree. The finder's repro was Node's `Headers.set`, which refuses a non-ByteString;
// workerd's does not. No change, no proof.

// edge#12 — BUG (fixed): `/expression?itx=itx.fetch` re-entered the lane through egress with the same
// query, unbounded. FIX: a hop-count header the lane increments and refuses past a few.
test("edge#12: the lane refuses to re-enter itself", async () => {
  const ctx = freshCtx("lane-reentry");
  const response = await fetch(expressionUrl(ctx, "itx.fetch"), {
    signal: AbortSignal.timeout(8000),
  });
  expect(response.status).toBe(508);
  expect(await response.text()).toMatch(/re-entered itself/);
});

// edge#13 — BUG (fixed): the DO owns a lent stub's rule and un-sets it one append AFTER the key's last
// pager closes (the un-set is an ordinary append), while the lender's recall disposes the session's
// dup at once. A call landing in that window — the rule still there, the dup gone — walked the
// disposed dup, and capnweb's raw "Attempted to use RPC stub after it has been disposed." escaped
// UNCODED to the caller: the relay re-coded only a BROKEN client session. Seen in 5 of 15 rounds
// against live-47 (fc58a49b). FIX: the relay re-codes every ended lend — recalled, returned, broken —
// to RPC_STUB_OFFLINE; once the un-set lands, default-deny answers NO_ITX_EXPRESSION_MATCH.
test("edge#13: a call in the window between a lender's recall and the DO's un-set is refused coded, never with capnweb's raw disposed error", async () => {
  // The window is a few ms wide, tens of ms after the dispose: six rounds of eight calls 1 ms apart
  // straddle it wherever it falls (a single call hit it in 5 of 15 rounds). The first calls of a
  // burst may still answer (the recall not yet at the edge), the last see the un-set.
  const answers: string[] = [];
  for (let round = 0; round < 6; round++) {
    const ctx = freshCtx(`recall-window-${round}`);
    const lender = openItx(ctx);
    const provided = await lender.provide(
      "itx.tool",
      new (class extends RpcTarget {
        ping() {
          return "pong";
        }
      })(),
    );
    const itx = openItx(ctx);
    expect(await itx.invoke("itx.tool.ping()")).toBe("pong");
    provided[Symbol.dispose]();
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      calls.push(itx.invoke("itx.tool.ping()"));
      await sleep(1);
    }
    for (const s of await Promise.allSettled(calls))
      answers.push(
        s.status === "fulfilled"
          ? String(s.value)
          : (codeOf(s.reason) ?? `UNCODED: ${(s.reason as Error).message}`),
      );
    const denied = await until("the un-set landed", async () => {
      const e = await rejection(itx.invoke("itx.tool.ping()"));
      return codeOf(e) === "RPC_STUB_OFFLINE" ? undefined : e; // the window — keep waiting
    });
    expect(codeOf(denied)).toBe("NO_ITX_EXPRESSION_MATCH");
  }
  expect(answers.filter((a) => a.startsWith("UNCODED"))).toEqual([]);
  for (const a of answers)
    expect(["pong", "RPC_STUB_OFFLINE", "NO_ITX_EXPRESSION_MATCH"]).toContain(a);
});
