// __workers-tests__/review-bugs-do-side.test.ts — RED proofs from the 2026-09-02 DO-side bug hunt
// (docs/reviews/2026-09-02-bugs-do-side.md). Every test here is marked `test.fails` — the house
// convention for a known-red proof, so the lane stays green — with the defect stated above it.
// Nothing is fixed: flipping a `test.fails` back to `test` is how a fix is proved.
//
// Two harnesses:
//   • THE DELIVERY HARNESS (`incarnation`) — a bare `Stream` over a DurableObjectStorage plus the
//     real `SubscriptionDelivery` wired to it, with `evaluateItxExpression` standing in for the
//     context's dispatch: it hands back the value an expression names and otherwise default-denies
//     exactly the way `rewriteItxExpressionToBuiltIn` does. That is the whole delivery loop, real,
//     with no facets or loader in the way — and building a SECOND one over the same storage is an
//     eviction, deterministically.
//   • THE DO ITSELF — `stub(ctx)` (+ `runInDurableObject` for its storage), for the append-time
//     facet effect.
//
// The fifth bug of the review — a failed load poisoning its loader cacheKey — is proved in
// e2e/review-bugs-do-side.e2e.test.ts instead: a failing dynamic-worker load leaves an unhandled
// rejection inside the runtime, which THIS in-process lane reports as a lane error.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { print, type ItxExpression } from "../src/context/expression.ts";
import { codedError } from "../src/lib/errors.ts";
import { Stream } from "../src/stream/stream.ts";
import { SubscriptionDelivery } from "../src/stream/subscription-delivery.ts";
import { subscriptionConfiguredEvent } from "../src/stream/subscriptions.ts";
import { stub } from "./support.ts";

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** ONE INCARNATION of the delivery machinery over `storage`: a `Stream` whose commit hook is the
 *  real `SubscriptionDelivery`. `resolve(printedExpression)` is the context's dispatch — return the
 *  value that expression names, or `undefined` to default-deny like the resolver does. Building a
 *  second one over the same storage is exactly what an eviction leaves behind: the durable log, the
 *  kv, and nothing else. */
function incarnation(
  storage: DurableObjectStorage,
  resolve: (printedExpression: string) => unknown,
): { stream: Stream; delivery: SubscriptionDelivery; evaluated: string[] } {
  const evaluated: string[] = [];
  let delivery!: SubscriptionDelivery;
  const stream = new Stream({
    storage,
    path: "/",
    projectId: "prj_bugs",
    onCommit: (fresh, after, next) => delivery.onCommit(fresh, after, next),
  });
  delivery = new SubscriptionDelivery({
    kv: storage.kv,
    stream,
    evaluateItxExpression: async (expression: ItxExpression) => {
      const printed = print(expression);
      evaluated.push(printed);
      const value = resolve(printed);
      if (value === undefined)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `no rewrite rule matches ${JSON.stringify(printed)} (default-deny)`,
        );
      return value;
    },
    recordActivityForQuietClock: () => {},
  });
  return { stream, delivery, evaluated };
}

// ── THE DELIVERY LOOP ─────────────────────────────────────────────────────────────────────────

// BUG: a cursor subscription whose FIRST delivery is interrupted by an eviction is stranded — the
// alarm's recovery pass never touches it, and no alarm was armed for it in the first place.
// WHY: two halves, of subscription-delivery.ts and iterate-context-durable-object.ts.
//   (a) `deliverEveryCursorSubscription` iterates `#cursors` — the CURSOR table, seeded from kv —
//       not the subscription ROWS. A subscription's first cursor is adopted with `writeKv: false`
//       ("the first durable delivery writes it"), so an eviction before that first ack leaves kv
//       with no cursor at all and the row invisible to the alarm forever.
//   (b) nothing armed an alarm anyway: `#recordActivityForQuietClock` returns early unless a facet
//       is live or an rpc stub is borrowed, and a cursor target is neither.
// So the committed events sit undelivered until some LATER commit happens to match the row's
// `consumes` — which on a quiet stream is never. That is the at-least-once guarantee, lost, in the
// exact case the DO's own alarm comment claims to cover ("anything an eviction left behind
// mid-delivery runs here").
// EXPECTED: the alarm's pass re-derives its obligations from the ROWS and delivers from the log
// (and the DO arms an alarm while any cursor subscription is behind).
test.fails("the alarm's cursor pass recovers a subscription whose first delivery an eviction interrupted", async () => {
  await runInDurableObject(stub("prj_bugs_cursor_eviction"), async (_instance, state) => {
    await state.storage.deleteAll();
    const neverAcks = new Promise<void>(() => {});
    const beforeEviction: number[] = [];
    const afterEviction: number[] = [];
    const ns = (events: { payload?: { n?: number } }[]) => events.map((e) => e.payload?.n ?? -1);

    const first = incarnation(state.storage, (printed) =>
      printed === "itx.sink"
        ? {
            push: async (events: { payload?: { n?: number } }[]) => {
              beforeEviction.push(...ns(events));
              await neverAcks; // the delivery the eviction interrupts
            },
          }
        : undefined,
    );
    first.stream.append(
      subscriptionConfiguredEvent({
        name: "s",
        target: "itx.sink.push",
        consumes: ["demo/ping"],
      }),
    );
    first.stream.append({ type: "demo/ping", payload: { n: 1 } });
    first.stream.append({ type: "demo/ping", payload: { n: 2 } });
    await settle();
    expect(beforeEviction).toEqual([1]); // in flight, never acked
    expect(state.storage.kv.get("subscription-cursor:s")).toBeUndefined(); // …so kv holds nothing
    expect(await state.storage.getAlarm()).toBeNull(); // …and nothing is armed to come back

    // THE EVICTION: a fresh incarnation over the same storage — the log and the kv, nothing else.
    const second = incarnation(state.storage, (printed) =>
      printed === "itx.sink"
        ? {
            push: (events: { payload?: { n?: number } }[]) =>
              void afterEviction.push(...ns(events)),
          }
        : undefined,
    );
    expect(Object.keys(second.stream.coreReducedState.subscriptions)).toEqual(["s"]); // the row survived
    await second.delivery.deliverEveryCursorSubscription(); // THE ALARM'S OWN DOOR
    await settle();

    expect(afterEviction).toEqual([1, 2]);
  });
});

// BUG: a subscription re-configured onto a NEW target while a cursor delivery is in flight keeps
// delivering to the OLD target — for good; the new target never receives anything.
// WHY: subscription-delivery.ts `#deliverFromCursor(name, call?)` takes the already-evaluated `call`
// as a parameter and only ever fills it with `call ??= …`. When the row is replaced mid-flight the
// loop DOES notice (`if (!this.#cursors.has(name)) continue;` — `#forgetSubscription` dropped the
// cursor) and picks up the new row and a fresh cursor, but `call` is already set to the old target's,
// so `??=` never re-evaluates. The replacement's own delivery attempt, meanwhile, returned early on
// `#cursorDeliveryRunning`, so nothing is left to deliver to the new target.
// EXPECTED: every batch after `subscription-configured` replaced the row goes to the NEW target.
test("a subscription re-configured mid-delivery delivers the next batch to the NEW target", async () => {
  await runInDurableObject(stub("prj_bugs_retarget"), async (_instance, state) => {
    await state.storage.deleteAll();
    const sinkA: number[][] = [];
    const sinkB: number[][] = [];
    let releaseSinkA!: () => void;
    const sinkAGate = new Promise<void>((r) => (releaseSinkA = r));
    const ns = (events: { payload?: { n?: number } }[]) => events.map((e) => e.payload?.n ?? -1);

    // Both targets are three-step (`itx.<sink>.push`), so the head/method split is the normal one.
    const { stream } = incarnation(state.storage, (printed) => {
      if (printed === "itx.sinkA")
        return {
          push: async (events: { payload?: { n?: number } }[]) => {
            sinkA.push(ns(events));
            await sinkAGate;
          },
        };
      if (printed === "itx.sinkB")
        return { push: (events: { payload?: { n?: number } }[]) => void sinkB.push(ns(events)) };
      return undefined;
    });

    stream.append(
      subscriptionConfiguredEvent({
        name: "s",
        target: "itx.sinkA.push",
        consumes: ["demo/ping"],
      }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settle();
    expect(sinkA).toEqual([[1]]); // the first batch is in flight, parked on the gate

    // The row is REPLACED while that delivery is parked, and a second batch lands behind it.
    stream.append(
      subscriptionConfiguredEvent({
        name: "s",
        target: "itx.sinkB.push",
        consumes: ["demo/ping"],
      }),
    );
    stream.append({ type: "demo/ping", payload: { n: 2 } });
    await settle();

    releaseSinkA();
    await settle();

    expect({ sinkA, sinkB }).toEqual({ sinkA: [[1]], sinkB: [[2]] });
  });
});

// BUG: a subscription target of exactly TWO steps — `itx.<alias>`, which is the spelling every
// `provide` mints (`itx.provide('itx.sink', stub)` writes the rule
// `itx.sink ⇒ itx.rpcStubs.get('itx.sink')`) — is never delivered to. It fails silently, once per
// commit, through `reportIssue`.
// WHY: subscription-delivery.ts `#evaluateItxExpressionTargetHead` splits a trailing STRING step off
// as "the method to call on the head", guarded only by `target.length > 1`. For `["itx","sink"]` that
// leaves the head as `["itx"]` — a bare scope root that no built-in and no rewrite rule can ever
// match — so the evaluation dies in the default-deny before the target is reached. The guard is off
// by one: only a target of THREE steps or more has a head to evaluate; a two-step one names the
// callee itself.
// EXPECTED: `subscribe({ target: 'itx.sink' })` delivers `(events, range)` to whatever `itx.sink`
// resolves to — the layer's own claim that "a rule whose target names another rule classifies
// correctly because it evaluates to the same handle".
test("a two-step subscription target (itx.<alias>) is delivered to", async () => {
  await runInDurableObject(stub("prj_bugs_alias_target"), async (_instance, state) => {
    await state.storage.deleteAll();
    const delivered: number[][] = [];
    const { stream, evaluated } = incarnation(state.storage, (printed) =>
      // What a rewrite rule resolves `itx.sink` to: the bare callable a client lent.
      printed === "itx.sink"
        ? (events: { payload?: { n?: number } }[]) =>
            void delivered.push(events.map((e) => e.payload?.n ?? -1))
        : undefined,
    );
    stream.append(
      subscriptionConfiguredEvent({ name: "mirror", target: "itx.sink", consumes: ["demo/ping"] }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settle();

    // FIXED 2026-09-03 (the guard is `> 2`): the target evaluated is `itx.sink` itself — once per
    // commit that reached the row (the configure's own batch, then the ping) — and the ping arrives.
    expect(delivered).toEqual([[1]]);
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.every((printed) => printed === "itx.sink")).toBe(true);
  });
});

// ── THE APPEND-TIME FACET EFFECT ──────────────────────────────────────────────────────────────

// BUG: `subscription-configured { name, target: null }` deletes the facet its row hosted even when
// ANOTHER live subscription row hosts the same facet — and `facets.delete` takes the facet's STORAGE
// with it, so the surviving processor silently rebuilds from offset 0 and re-runs every effect it
// ever ran (double effects), while a spec-less `itx.facets.get(name)` now answers NO_FACET.
// WHY: iterate-context-durable-object.ts `#deleteFacetsWhoseHostingSubscriptionWasRemoved` reads the
// removed row's target, sees `facets.get(<name>, <spec>)`, and deletes `<name>` unconditionally.
// Nothing consults the other rows — which are right there, in the very same pre-commit
// `subscriptionsBeforeCommit` map the function was handed.
// EXPECTED: the facet (and its storage) survives while any remaining subscription row still hosts it.
const COUNTER_SRC = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  bump() { const n = (this.ctx.storage.kv.get("n") ?? 0) + 1; this.ctx.storage.kv.put("n", n); return n; }
  count() { return this.ctx.storage.kv.get("n") ?? 0; }
  processEventBatch() {}
  catchUpFromLog() {}
}
`;
test("removing one hosting subscription keeps the facet another row still hosts", async () => {
  const context = stub("prj_bugs_shared_facet");
  const spec = { source: { "cap.js": COUNTER_SRC }, className: "CounterDurableObject" };
  const target: ItxExpression = ["itx", "facets", ["get", "shared", spec], "processEventBatch"];

  // Two rows, both HOSTING the same facet — the `enableProcessor` shape, twice.
  await context.append(subscriptionConfiguredEvent({ name: "a", target, consumes: ["demo/ping"] }));
  await context.append(subscriptionConfiguredEvent({ name: "b", target, consumes: ["demo/ping"] }));
  // Give the facet state of its own; a processor's reduce checkpoint stands in for this.
  await context.invoke(["itx", "facets", ["get", "shared", spec], ["bump"]]);
  await context.invoke(["itx", "facets", ["get", "shared", spec], ["bump"]]);
  expect(await context.invoke(["itx", "facets", ["get", "shared", spec], ["count"]])).toBe(2);

  // Remove ONE of the two rows. The other still hosts the facet.
  await context.append(subscriptionConfiguredEvent({ name: "a", target: null }));
  const core = (await context.invoke("itx.facets.get('core').snapshot()")) as {
    state: { subscriptions: Record<string, unknown> };
  };
  expect(Object.keys(core.state.subscriptions)).toEqual(["b"]);

  // The startup memo row "b" depends on, and the facet's own storage, must both still be there.
  const memo = await runInDurableObject(context, (_instance, state) =>
    Promise.resolve(state.storage.kv.get("facet:shared") ?? null),
  );
  const count = await context.invoke(["itx", "facets", ["get", "shared", spec], ["count"]]);
  expect({ memoKept: memo !== null, count }).toEqual({ memoKept: true, count: 2 });
});
