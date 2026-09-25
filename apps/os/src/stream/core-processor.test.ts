// The core reduce's executable spec (src/stream/core-processor.ts): ONE pure reduce of the context's
// control events into the state the DO reads SYNCHRONOUSLY in its handlers — identity (created),
// incarnation (woken), the pause latch (paused/resumed), the itx-expression rewrite rules (a MAP by
// match: configured sets or, with a null target, deletes), the subscriptions table (by name:
// configured REPLACES or, with a null target, drops; delivery-halted marks, delivery-resumed clears
// the halt and records the seek). No clock, no effects: the same log always reduces to the same state, an ephemeral
// event never reduces (the checkpoint must rebuild from the durable log alone), and a malformed
// hand-appended event THROWS at the reduce — the host contains it (stream.test.ts pins the skip). The COMMANDS that build these events are pinned beside their modules
// (context/itx-expression-rewriting.test.ts, the subscriptions section below).
import { expect, test } from "vitest";
import { parse, print, type ItxExpression, type ItxExpressionInput } from "iterate/expression";
import type { StreamEvent } from "iterate/stream/processor";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import {
  CoreContract,
  facetIsPushedByARow,
  reduceCoreEvent,
  reduceCoreEventBatch,
  type CoreState,
  normalizeControlEvent,
} from "./core-processor.ts";
import { Stream } from "./stream.ts";
import { nodeSqliteStream } from "./test-support.ts";

// ── the contract ──

test("the contract: slug `core`; the every-field-defaulted initial state", () => {
  expect(CoreContract).toMatchObject({ slug: "core" });
  expect(CoreContract.initialState()).toEqual({
    paused: null,
    itxExpressionRewriteRules: {},
    subscriptions: {},
    ingressTarget: null,
    fetchRoutes: {},
    schedules: {},
    scriptRuns: {},
  });
  // the events it OWNS beyond its control events: the apex target and a child's announcement
  // (core-events.ts, which the Project contract depends on) and the run pair
  expect(Object.keys(CoreContract.events)).toEqual([
    "events.iterate.com/itx/ingress-configured",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/itx/run-requested",
    "events.iterate.com/itx/run-settled",
  ]);
});

// ── the scriptRuns table — by the request's offset: requested opens, settled closes, nothing else ──

test("scriptRuns: requested → a row at its own offset { requestedAt } (the event's identity; the code stays on the event)", () => {
  expect(reduceAll([requested(5)])).toEqual(
    expect.objectContaining({ scriptRuns: { 5: { requestedAt: new Date(5000).toISOString() } } }),
  );
});
test("scriptRuns: settled removes the row; settled twice, or for a request never made → undefined (keep the state)", () => {
  const open = reduceAll([requested(5)]);
  const closed = reduceAll([settled(7, 5)], open);
  // objectContaining compares each key it names with full equality: `{}` is an EMPTY table (toMatchObject's `{}` matches any)
  expect(closed).toEqual(expect.objectContaining({ scriptRuns: {} }));
  expect(reduceCoreEvent({ event: settled(8, 5), state: closed })).toBeUndefined();
  expect(reduceCoreEvent({ event: settled(8, 99), state: open })).toBeUndefined();
});
test("scriptRuns: two open runs are two rows; each settles on its own", () => {
  const state = reduceAll([requested(5), requested(6), settled(7, 5)]);
  expect(Object.keys(state.scriptRuns)).toEqual(["6"]);
});
test("scriptRuns: a malformed payload (an empty code, a missing settlement) is refused at the append boundary, before it can reach the reduce", () => {
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/run-requested",
        payload: { code: "" },
      },
      "/",
    ),
  ).toThrow();
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/run-settled",
        payload: { requestOffset: 5 },
      },
      "/",
    ),
  ).toThrow();
});
test("scriptRuns: the append boundary (normalizeControlEvent) parses both payloads against the contract's schemas and refuses an ephemeral one — the table is rebuilt from the durable log", () => {
  expect(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/run-requested",
        payload: { code: "async (itx) => 1", extra: "dropped" },
      },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: "async (itx) => 1" },
  });
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/run-settled",
        payload: {
          requestOffset: 5,
          settlement: { status: "failed", error: "x", failureKind: "expired" },
        },
      },
      "/",
    ),
  ).toThrow();
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/run-requested",
        ephemeral: true,
        payload: { code: "async (itx) => 1" },
      },
      "/",
    ),
  ).toThrow(/durable/);
});

test.each([
  ["events.iterate.com/itx/created", { projectId: "prj_other", path: "/elsewhere" }],
  ["events.iterate.com/itx/woken", { incarnation: 99 }],
  [
    "events.iterate.com/itx/subscription-delivery-halted",
    { name: "someone-elses", afterOffset: 1, attempts: 1 },
  ],
  ["events.iterate.com/itx/alarm-trace", {}],
])("%s is the platform's own record: the append boundary refuses it", (type, payload) => {
  expect(() => normalizeControlEvent({ type, payload }, "/")).toThrow(/platform's own record/);
});

test("an operator's pause, resume and delivery resume are parsed at the append boundary: the reduce's casts are true", () => {
  // stored as sent: a bare pause stays bare, so a keyed retry still matches the committed event
  expect(normalizeControlEvent({ type: "events.iterate.com/itx/paused" }, "/")).toEqual({
    type: "events.iterate.com/itx/paused",
  });
  expect(
    normalizeControlEvent(
      { type: "events.iterate.com/itx/paused", payload: { reason: "breaker" } },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/paused",
    payload: { reason: "breaker" },
  });
  for (const payload of [{ reason: 42 }, { reason: "breaker", extra: 1 }])
    expect(() =>
      normalizeControlEvent({ type: "events.iterate.com/itx/paused", payload }, "/"),
    ).toThrow();
  expect(normalizeControlEvent({ type: "events.iterate.com/itx/resumed" }, "/")).toEqual({
    type: "events.iterate.com/itx/resumed",
  });
  expect(() =>
    normalizeControlEvent({ type: "events.iterate.com/itx/resumed", payload: { extra: 1 } }, "/"),
  ).toThrow();
  expect(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/subscription-delivery-resumed",
        payload: { name: "s", afterOffset: 0 },
      },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "s", afterOffset: 0 },
  });
  // a non-numeric seek would have become a NaN cursor in the delivery loop; a prototype key would
  // have read `Object.prototype` as a row, and `core` is never a subscription
  for (const payload of [
    {},
    { name: 1 },
    { name: "s", afterOffset: "3" },
    { name: "s", afterOffset: -1 },
    { name: "constructor" },
    { name: "toString" },
    { name: "__proto__" },
    { name: "core" },
    { name: "a/b" },
  ])
    expect(() =>
      normalizeControlEvent(
        { type: "events.iterate.com/itx/subscription-delivery-resumed", payload },
        "/",
      ),
    ).toThrow();
});

// ── identity, incarnation, the pause latch ──

test("created → projectId, path, createdAt (the birth certificate's own timestamp)", () => {
  const born = at(1, "events.iterate.com/itx/created", { projectId: "prj_t", path: "/" });
  const s = reduceAll([born]);
  expect(s).toMatchObject({ projectId: "prj_t", path: "/", createdAt: born.createdAt });
});

test("woken → incarnation; every wake overwrites (growth across idle is the hibernation tell); identity untouched", () => {
  const s = reduceAll([
    at(1, "events.iterate.com/itx/created", { projectId: "prj_t", path: "/" }),
    at(2, "events.iterate.com/itx/woken", { incarnation: 1 }),
    at(3, "events.iterate.com/itx/woken", { incarnation: 2 }),
  ]);
  expect(s).toMatchObject({ incarnation: 2, projectId: "prj_t" });
});

test.each([
  {
    log: "aborted, then woken (the reset itx.abort() asked for)",
    types: ["events.iterate.com/itx/aborted", "events.iterate.com/itx/woken"],
    wokenAfterContextAbortedOffset: 2,
  },
  {
    log: "aborted, woken, woken again (a later wake: hibernation, a platform reset)",
    types: [
      "events.iterate.com/itx/aborted",
      "events.iterate.com/itx/woken",
      "events.iterate.com/itx/woken",
    ],
    wokenAfterContextAbortedOffset: undefined,
  },
  {
    log: "woken, then aborted (the reset still to come)",
    types: ["events.iterate.com/itx/woken", "events.iterate.com/itx/aborted"],
    wokenAfterContextAbortedOffset: undefined,
  },
])("$log → wokenAfterContextAbortedOffset $wokenAfterContextAbortedOffset", (row) => {
  const s = reduceAll(
    row.types.map((type, index) =>
      at(index + 2, type, type === "events.iterate.com/itx/woken" ? { incarnation: index } : {}),
    ),
  );
  expect(s).toMatchObject({ wokenAfterContextAbortedOffset: row.wokenAfterContextAbortedOffset });
});

test("pause is a latch: paused → resumed round-trips; reason carried", () => {
  const paused = reduceAll([at(1, "events.iterate.com/itx/paused", { reason: "maintenance" })]);
  expect(paused).toMatchObject({ paused: { reason: "maintenance" } });
  expect(reduceAll([at(2, "events.iterate.com/itx/resumed")], paused).paused).toBeNull();
});

test('paused without a reason defaults to "paused" in the reduce (the state guarantee)', () => {
  expect(reduceAll([at(1, "events.iterate.com/itx/paused")])).toMatchObject({
    paused: { reason: "paused" },
  });
  expect(reduceAll([at(1, "events.iterate.com/itx/paused", {})])).toMatchObject({
    paused: { reason: "paused" },
  });
});

// ── the ingress target — itx/ingress-configured, normalized at the append boundary ──

const ingressTarget: ItxExpression = [
  "itx",
  "workers",
  ["get", { source: { "cap.js": "source" } }],
];

test("ingress target: stores and replaces the full expression without creating any rewrite alias; null clears it; an unchanged or ephemeral event keeps the state", () => {
  const event = {
    ...normalizeControlEvent(
      { type: "events.iterate.com/itx/ingress-configured", payload: { target: ingressTarget } },
      "/",
    ),
    offset: 1,
    path: "/",
    createdAt: "2026-09-21T00:00:00Z",
  };
  const state = reduceCoreEvent({ event, state: CoreContract.initialState() })!;
  expect(state).toEqual(
    expect.objectContaining({ ingressTarget: ingressTarget, itxExpressionRewriteRules: {} }),
  );
  expect(
    reduceCoreEvent({ event: { ...event, payload: { target: null } }, state })?.ingressTarget,
  ).toBeNull();
  expect(reduceCoreEvent({ event, state })).toBeUndefined();
  expect(
    reduceCoreEvent({ event: { ...event, ephemeral: true }, state: CoreContract.initialState() }),
  ).toBeUndefined();
});

test.each([{}, { target: 123 }, { target: "other.workers" }, { target: ["itx", null] }])(
  "ingress target: an invalid configuration is refused at the boundary, before append: %j",
  (payload) => {
    expect(() =>
      normalizeControlEvent({ type: "events.iterate.com/itx/ingress-configured", payload }, "/"),
    ).toThrow();
  },
);

test("ingress target: an ephemeral configuration cannot be published", () => {
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/ingress-configured",
        payload: { target: ingressTarget },
        ephemeral: true,
      },
      "/",
    ),
  ).toThrow("must be durable");
});

// ── the fetch routes — itx/fetch-route-configured, folded by src/fetch-routes.ts ──

const blogRoute = {
  fetchRouteName: "tunnel-blog",
  requestMatcher: { routingSlug: "blog" },
  target: ["itx", "tunnels", "blog"],
};

test("fetch routes: a fact sets its route at its offset and a null matcher deletes it; deleting a route that is not there, or an ephemeral fact, keeps the state", () => {
  const set = reduceAll([at(4, "events.iterate.com/itx/fetch-route-configured", blogRoute)]);
  expect(set).toEqual(
    expect.objectContaining({
      fetchRoutes: {
        "tunnel-blog": {
          requestMatcher: { routingSlug: "blog" },
          target: ["itx", "tunnels", "blog"],
          authRequirement: null,
          priority: 0,
          configuredOffset: 4,
        },
      },
    }),
  );
  const deleted = { fetchRouteName: "tunnel-blog", requestMatcher: null };
  expect(reduceAll([at(5, "events.iterate.com/itx/fetch-route-configured", deleted)], set)).toEqual(
    expect.objectContaining({ fetchRoutes: {} }),
  );
  expect(
    reduceCoreEvent({
      event: at(5, "events.iterate.com/itx/fetch-route-configured", {
        ...deleted,
        fetchRouteName: "gone",
      }),
      state: set,
    }),
  ).toBeUndefined();
  expect(
    reduceCoreEvent({
      event: {
        ...at(5, "events.iterate.com/itx/fetch-route-configured", blogRoute),
        ephemeral: true,
      },
      state: CoreContract.initialState(),
    }),
  ).toBeUndefined();
});

test("fetch routes: a malformed fact in the log is skipped by the reduce, never thrown, so one route that does not compile never breaks every request's match", () => {
  const badUrl = {
    ...blogRoute,
    fetchRouteName: "bad-url",
    requestMatcher: { url: { pathname: "(" } },
  };
  const state = reduceCoreEventBatch(
    [
      at(1, "events.iterate.com/itx/fetch-route-configured", badUrl),
      at(2, "events.iterate.com/itx/fetch-route-configured", blogRoute),
    ],
    CoreContract.initialState(),
    onError,
  );
  expect(Object.keys(state.fetchRoutes)).toEqual(["tunnel-blog"]);
});

test("fetch routes: the append boundary parses the fact and refuses a malformed or ephemeral one", () => {
  expect(
    normalizeControlEvent(
      { type: "events.iterate.com/itx/fetch-route-configured", payload: blogRoute },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/fetch-route-configured",
    payload: blogRoute,
  });
  for (const payload of [
    {},
    { ...blogRoute, fetchRouteName: "Tunnel_Blog" },
    { fetchRouteName: "no-target", requestMatcher: {} },
    { ...blogRoute, requestMatcher: { url: { pathname: "(" } } },
    { ...blogRoute, requestMatcher: { method: "GET" } },
  ])
    expect(() =>
      normalizeControlEvent(
        { type: "events.iterate.com/itx/fetch-route-configured", payload },
        "/",
      ),
    ).toThrow();
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/fetch-route-configured",
        payload: blogRoute,
        ephemeral: true,
      },
      "/",
    ),
  ).toThrow("must be durable");
});

test(
  "fetch routes: a core-version bump re-reduces a root's routes in O(routes) per page — 14,000 routes (a core checkpoint of ~2 MB) well under the CPU limit (a copy per fact is O(routes²): ~25 s on a laptop)",
  { timeout: 60_000 },
  () => {
    const storage = nodeSqliteDurableObjectStorage();
    const deps = { storage, path: "/", projectId: "prj_t", onCommit: () => {} };
    const before = new Stream(deps);
    for (let first = 0; first < 14_000; first += 500)
      before.append(
        ...Array.from({ length: 500 }, (_, i) =>
          normalizeControlEvent(
            {
              type: "events.iterate.com/itx/fetch-route-configured",
              payload: numberedRoute(first + i),
            },
            "/",
          ),
        ),
      );
    before.storage.reduceCheckpoints.write(
      CoreContract.slug,
      { reducerVersion: "13.0.0", reducedThroughOffset: before.highestDurableOffset() },
      undefined,
      false,
    );
    const startedAt = performance.now();
    const rebuilt = new Stream(deps);
    const rereduceMs = performance.now() - startedAt;
    expect(Object.keys(rebuilt.coreReducedState.fetchRoutes)).toHaveLength(14_000);
    expect(rereduceMs).toBeLessThan(5_000);
  },
);

// ── the rewrite-rule table — a MAP by match ──

test("rewrite rules: configured sets a PARSED rule (string at rest, structured in state) under its canonical match", () => {
  const s = reduceAll([
    at(7, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.db",
      target: "itx.facets.get('tab-1')",
    }),
  ]);
  expect(s).toMatchObject({
    itxExpressionRewriteRules: {
      "itx.db": { match: ["itx", "db"], target: parse("itx.facets.get('tab-1')") },
    },
  });
});

test("rewrite rules: the SAME match REPLACES (a map, never a stack); a null target DELETES exactly that match; null on nothing → undefined (keep the state)", () => {
  const set = reduceAll([
    at(1, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.greeter",
      target: "itx.tab1",
    }),
    at(2, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.greeter",
      target: "itx.tab2",
    }),
    at(3, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.other",
      target: "itx.kv",
    }),
  ]);
  expect(Object.keys(set.itxExpressionRewriteRules)).toEqual(["itx.greeter", "itx.other"]);
  expect(print(set.itxExpressionRewriteRules["itx.greeter"].target!)).toBe("itx.tab2");
  const deleted = reduceAll(
    [
      at(4, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.greeter",
        target: null,
      }),
    ],
    set,
  );
  expect(Object.keys(deleted.itxExpressionRewriteRules)).toEqual(["itx.other"]);
  // deleting a match that has no rule (already gone, or never set) changes nothing — a benign
  // double-delete must not rewrite the checkpoint or publish a live-state delta
  expect(
    reduceCoreEvent({
      event: at(5, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.greeter",
        target: null,
      }),
      state: deleted,
    }),
  ).toBeUndefined();
});

test("rewrite rules: a malformed configured (a match with an argless call step, an unbalanced target) THROWS at the reduce — the host skips it (stream.test.ts); a well-formed one still reduces", () => {
  const state = CoreContract.initialState();
  for (const payload of [
    { match: "itx.broken(", target: "itx.kv" },
    { match: "itx.call()", target: "itx.kv" },
    { match: "itx.dangling", target: "itx.kv.get(" },
  ])
    expect(() =>
      reduceCoreEvent({
        event: at(1, "events.iterate.com/itx/rewrite-rule-configured", payload),
        state,
      }),
    ).toThrow();
  const s = reduceAll([
    at(4, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.fine",
      target: "itx.kv",
    }),
  ]);
  expect(Object.keys(s.itxExpressionRewriteRules)).toEqual(["itx.fine"]);
});

// A rule match whose CANONICAL form crosses the string codec cap still reduces. The boundary
// stores the match as the PARSED prefix (not a re-stringified canonical that `print` could expand
// past 2048 — `1e99`→`1e+99`), so the reduce reads it in place and only `print`s it for the table
// key (printing has no cap). Boundary and reduce agree: the boundary accepts it, the reduce
// stores it.
test("rewrite rules: a well-formed match the boundary accepts reduces even when its canonical form crosses the codec cap", () => {
  const longMatch = "itx.foo(" + Array(400).fill("1e99").join(",") + ")";
  const normalized = normalizeControlEvent(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: longMatch, target: "itx.kv" },
    },
    "/",
  );
  expect(Array.isArray((normalized.payload as { match: unknown }).match)).toBe(true); // parsed, not re-stringified
  const reduced = reduceCoreEvent({
    event: at(1, normalized.type, normalized.payload as Record<string, unknown>),
    state: CoreContract.initialState(),
  });
  expect(Object.keys(reduced?.itxExpressionRewriteRules ?? {})).toHaveLength(1);
});

test("rewrite rules: a removal with `ifTarget` (a handle's undo) applies only while the row's target is still that — a replacement survives a stale undo, identity kept; a mask's undo names `null`", () => {
  const configure = (offset: number, target: string | null) =>
    at(offset, "events.iterate.com/itx/rewrite-rule-configured", { match: "itx.x", target });
  const remove = (offset: number, ifTarget: unknown) =>
    at(offset, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.x",
      target: "itx.builtins.x",
      ifTarget,
    });
  const replaced = reduceAll([configure(1, "itx.tab1"), configure(2, "itx.tab2")]);
  // the first handle's undo arrives after the replacement: a no-op, the very same state object
  expect(reduceCoreEvent({ event: remove(3, parse("itx.tab1")), state: replaced })).toBeUndefined();
  // the row's own handle removes it
  expect(reduceAll([remove(3, parse("itx.tab2"))], replaced)).toEqual(
    expect.objectContaining({ itxExpressionRewriteRules: {} }),
  );
  // an undo over a row that is already gone: a no-op too
  expect(
    reduceCoreEvent({ event: remove(4, parse("itx.tab2")), state: CoreContract.initialState() }),
  ).toBeUndefined();
  // a MASK's handle undoes with `ifTarget: null` — lifting the mask, never someone else's rewrite
  const masked = reduceAll([configure(1, null)]);
  expect(reduceAll([remove(2, null)], masked)).toEqual(
    expect.objectContaining({ itxExpressionRewriteRules: {} }),
  );
  const rewritten = reduceAll([configure(1, null), configure(2, "itx.tab1")]);
  expect(reduceCoreEvent({ event: remove(3, null), state: rewritten })).toBeUndefined();
});

// ── the subscriptions table — by name ──

test("subscriptions table: configured: a row is `{ target (parsed), consumes?, configuredAtOffset }` — the event's own offset is its identity", () => {
  const e = at(3, "events.iterate.com/itx/subscription-configured", {
    name: "tab",
    target: "itx.rpcStubs.get('subscription:tab')",
    consumes: ["mark"],
  });
  expect(reduceAll([e])).toEqual(
    expect.objectContaining({
      subscriptions: {
        tab: {
          target: parse("itx.rpcStubs.get('subscription:tab')"),
          consumes: ["mark"],
          configuredAtOffset: 3,
        },
      },
    }),
  );
});

test("subscriptions table: configured with `afterOffset` stores it on the row (where cursor delivery starts — 0 = the whole log); without it, no key at all (= from the configure offset)", () => {
  const s = reduceAll([
    at(4, "events.iterate.com/itx/subscription-configured", {
      name: "history",
      target: "itx.digest.processEventBatch",
      afterOffset: 0,
    }),
    at(5, "events.iterate.com/itx/subscription-configured", {
      name: "now",
      target: "itx.digest.processEventBatch",
    }),
  ]);
  expect(s.subscriptions.history).toMatchObject({ configuredAtOffset: 4, afterOffset: 0 });
  expect(s.subscriptions.now).not.toHaveProperty("afterOffset");
});

test("subscriptions table: configured without `consumes` stores no `consumes` key at all (absent = every durable event)", () => {
  const s = reduceAll([
    at(1, "events.iterate.com/itx/subscription-configured", {
      name: "all",
      target: "itx.facets.get('tally').processEventBatch",
    }),
  ]);
  expect(s.subscriptions.all).not.toHaveProperty("consumes");
});

test("subscriptions table: configured with the SAME NAME REPLACES the row — no shadow stack, the old target and filter are gone", () => {
  const s = reduceAll([
    at(1, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: "itx.old.processEventBatch",
      consumes: ["a"],
    }),
    at(2, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: "itx.new.processEventBatch",
    }),
  ]);
  expect(Object.keys(s.subscriptions)).toEqual(["digest"]);
  expect(print(s.subscriptions.digest.target)).toBe("itx.new.processEventBatch");
  expect(s.subscriptions.digest).toMatchObject({ configuredAtOffset: 2 });
  expect(s.subscriptions.digest).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
});

test("subscriptions table: configured with a NULL target drops the row; dropping an unknown name → undefined (keep the state), never a throw or a phantom row", () => {
  const s = reduceAll([
    at(1, "events.iterate.com/itx/subscription-configured", { name: "a", target: "itx.x.f" }),
    at(2, "events.iterate.com/itx/subscription-configured", { name: "b", target: "itx.y.f" }),
    at(3, "events.iterate.com/itx/subscription-configured", { name: "a", target: null }),
  ]);
  expect(Object.keys(s.subscriptions)).toEqual(["b"]);
  expect(
    reduceCoreEvent({
      event: at(4, "events.iterate.com/itx/subscription-configured", {
        name: "ghost",
        target: null,
      }),
      state: s,
    }),
  ).toBeUndefined();
});

test("subscriptions table: a null target with `ifConfiguredAtOffset` (a handle's undo) drops only the row configured at that offset — a same-name replace survives the stale undo, identity kept", () => {
  const configure = (offset: number) =>
    at(offset, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: "itx.digest.processEventBatch",
    });
  const remove = (offset: number, ifConfiguredAtOffset: number) =>
    at(offset, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: null,
      ifConfiguredAtOffset,
    });
  const replaced = reduceAll([configure(1), configure(2)]);
  expect(reduceCoreEvent({ event: remove(3, 1), state: replaced })).toBeUndefined(); // the first handle's stale undo
  expect(reduceAll([remove(3, 2)], replaced)).toEqual(
    expect.objectContaining({ subscriptions: {} }),
  ); // the row's own handle
  expect(
    reduceCoreEvent({ event: remove(4, 2), state: CoreContract.initialState() }),
  ).toBeUndefined(); // already gone
});

test("subscriptions table: delivery-halted sets `halted { afterOffset, attempts, error? }` on the row (the loop's fact); unknown name → no-op", () => {
  const configured = reduceAll([
    at(1, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: "itx.digest.processEventBatch",
    }),
  ]);
  const halted = reduceAll(
    [
      at(2, "events.iterate.com/itx/subscription-delivery-halted", {
        name: "digest",
        afterOffset: 7,
        attempts: 15,
        error: "boom",
      }),
    ],
    configured,
  );
  expect(halted.subscriptions.digest).toMatchObject({
    halted: { afterOffset: 7, attempts: 15, error: "boom" },
  });
  // without `error` the key is absent, not undefined-valued
  const rehalted = reduceAll(
    [
      at(3, "events.iterate.com/itx/subscription-delivery-halted", {
        name: "digest",
        afterOffset: 9,
        attempts: 1,
      }),
    ],
    halted,
  );
  expect(rehalted.subscriptions.digest).toMatchObject({ halted: { afterOffset: 9, attempts: 1 } });
  expect(rehalted.subscriptions.digest.halted).not.toHaveProperty("error");
  // a halt for a name that has no row is dropped on the floor
  expect(
    reduceCoreEvent({
      event: at(4, "events.iterate.com/itx/subscription-delivery-halted", {
        name: "nobody",
        afterOffset: 1,
        attempts: 1,
      }),
      state: rehalted,
    }),
  ).toBeUndefined();
});

test("subscriptions table: delivery-resumed CLEARS `halted` and records `resumed { afterOffset?, atOffset }` — atOffset is the resume event's own offset; unknown name → no-op", () => {
  const halted = reduceAll([
    at(1, "events.iterate.com/itx/subscription-configured", {
      name: "digest",
      target: "itx.digest.processEventBatch",
    }),
    at(2, "events.iterate.com/itx/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 7,
      attempts: 15,
    }),
  ]);
  const sought = reduceAll(
    [
      at(3, "events.iterate.com/itx/subscription-delivery-resumed", {
        name: "digest",
        afterOffset: 8,
      }),
    ],
    halted,
  );
  expect(sought.subscriptions.digest).not.toHaveProperty("halted");
  expect(sought.subscriptions.digest).toMatchObject({ resumed: { afterOffset: 8, atOffset: 3 } });
  // a plain un-halt (no seek): `resumed` carries only the generation
  const plain = reduceAll(
    [at(4, "events.iterate.com/itx/subscription-delivery-resumed", { name: "digest" })],
    sought,
  );
  expect(plain.subscriptions.digest.resumed).not.toHaveProperty("afterOffset");
  // and it keeps the row's other fields intact
  expect(plain.subscriptions.digest).toMatchObject({
    resumed: { atOffset: 4 },
    configuredAtOffset: 1,
  });
  expect(print(plain.subscriptions.digest.target)).toBe("itx.digest.processEventBatch");
  expect(
    reduceCoreEvent({
      event: at(5, "events.iterate.com/itx/subscription-delivery-resumed", { name: "nobody" }),
      state: plain,
    }),
  ).toBeUndefined();
});

test("subscriptions table: a malformed target THROWS at the reduce (no row) — the host skips it (stream.test.ts); a well-formed one still reduces", () => {
  expect(() =>
    reduceCoreEvent({
      event: at(1, "events.iterate.com/itx/subscription-configured", {
        name: "broken",
        target: "itx.broken(", // does not parse
      }),
      state: CoreContract.initialState(),
    }),
  ).toThrow();
  const s = reduceAll([
    at(2, "events.iterate.com/itx/subscription-configured", {
      name: "fine",
      target: "itx.whoami",
    }),
  ]);
  expect(Object.keys(s.subscriptions)).toEqual(["fine"]);
});

// ── purity ──

test("an EPHEMERAL event is never reduced, whatever its type — the state is rebuildable from the durable log alone", () => {
  const state = CoreContract.initialState();
  const ephemeral = (type: string, payload: Record<string, unknown>): StreamEvent => ({
    ...at(1, type, payload),
    ephemeral: true,
  });
  for (const e of [
    ephemeral("events.iterate.com/itx/created", { projectId: "p", path: "/" }),
    ephemeral("events.iterate.com/itx/woken", { incarnation: 9 }),
    ephemeral("events.iterate.com/itx/paused", { reason: "x" }),
    ephemeral("events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.blip",
      target: "itx.kv",
    }),
    ephemeral("events.iterate.com/itx/subscription-configured", {
      name: "blip",
      target: "itx.whoami",
    }),
  ])
    expect(reduceCoreEvent({ event: e, state })).toBeUndefined();
});

test("purity: an event the reduce does not know → undefined (keep the state)", () => {
  expect(
    reduceCoreEvent({ event: at(1, "work"), state: CoreContract.initialState() }),
  ).toBeUndefined();
});

// `reduceCoreEventBatch` is what the host calls (Stream reduces a commit's fresh events and each page of the
// constructor's re-reduce through it): each core table is copied ONCE per batch and mutated as a
// draft after — O(rows + events), not O(rows × events) (memory-budget.test.ts pins the time). What
// that must NOT cost is purity at the batch's edges: the state handed in stays what it was.
// ── reduceCoreEventBatch — a batch's draft tables never leak into the state it was given ──

test("reduceCoreEventBatch: a batch folds to exactly the per-event fold; the input state and its tables are untouched — and a second batch over the result leaves the first result untouched too", () => {
  const first = [
    configured(1, "a"),
    rule(2, "itx.x", "itx.kv"),
    configured(3, "b"),
    at(4, "events.iterate.com/itx/fetch-route-configured", numberedRoute(1)),
    at(5, "events.iterate.com/itx/fetch-route-configured", numberedRoute(2)),
  ];
  const second = [
    configured(6, "a", "itx.y.f"),
    rule(7, "itx.x", null),
    configured(8, "b", null),
    at(9, "events.iterate.com/itx/fetch-route-configured", {
      fetchRouteName: "route-1",
      requestMatcher: null,
    }),
    at(10, "events.iterate.com/itx/fetch-route-configured", { ...numberedRoute(2), priority: 5 }),
  ];
  const initial = CoreContract.initialState();
  const afterFirst = reduceCoreEventBatch(first, initial, onError);
  expect(afterFirst).toEqual(reduceAll(first));
  expect(initial).toEqual(CoreContract.initialState()); // the given state: not a row leaked into it
  const afterFirstSnapshot = JSON.parse(JSON.stringify(afterFirst));
  const afterSecond = reduceCoreEventBatch(second, afterFirst, onError);
  expect(afterSecond).toEqual(reduceAll([...first, ...second]));
  expect(afterFirst).toEqual(afterFirstSnapshot); // the previous batch's result: immutable
  // a fresh draft, not a shared table — identity, which no object match can state
  // oxlint-disable-next-line iterate/prefer-object-property-match -- identity: not the same table object
  expect(afterSecond.subscriptions).not.toBe(afterFirst.subscriptions);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- identity: not the same table object
  expect(afterSecond.itxExpressionRewriteRules).not.toBe(afterFirst.itxExpressionRewriteRules);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- identity: not the same table object
  expect(afterSecond.fetchRoutes).not.toBe(afterFirst.fetchRoutes);
  expect(Object.keys(afterSecond.fetchRoutes)).toEqual(["route-2"]);
});

test("reduceCoreEventBatch: a batch that touches nothing hands the SAME state back (identity is the host's change signal — no checkpoint rewrite, no live delta)", () => {
  const state = reduceCoreEventBatch([configured(1, "a")], CoreContract.initialState(), onError);
  expect(
    reduceCoreEventBatch(
      [at(2, "work"), { ...configured(3, "z"), ephemeral: true }],
      state,
      onError,
    ),
  ).toBe(state);
});

test("reduceCoreEventBatch: a throwing event is handed to onError and SKIPPED — the events after it still reduce, and its state is the previous event's", () => {
  const reported: number[] = [];
  const state = reduceCoreEventBatch(
    [configured(1, "a"), rule(2, "itx.call()", "itx.kv"), configured(3, "b")],
    CoreContract.initialState(),
    (_error, event) => void reported.push(event.offset),
  );
  expect(reported).toEqual([2]);
  expect(Object.keys(state.subscriptions)).toEqual(["a", "b"]);
  expect(state).toEqual(expect.objectContaining({ itxExpressionRewriteRules: {} }));
});

// ── the builtins root, as the reduce sees it: masks, the platform-equivalent target, hosting on the RESOLVED target ──

const SPEC = { source: { "cap.js": "export class T {}" }, className: "TallyDurableObject" };
test("builtins root: `null` at a built-in's name is KEPT as a mask row; `null` at a plain name deletes; a repeat of either is a no-op (undefined)", () => {
  const masked = reduceAll([
    at(1, "events.iterate.com/itx/rewrite-rule-configured", { match: "itx.kv", target: null }),
    at(2, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.other",
      target: "itx.kv",
    }),
    at(3, "events.iterate.com/itx/rewrite-rule-configured", { match: "itx.other", target: null }),
    at(4, "events.iterate.com/itx/rewrite-rule-configured", { match: "itx", target: null }),
    at(5, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.kv.get('a')",
      target: null,
    }),
  ]);
  expect(Object.keys(masked.itxExpressionRewriteRules).sort()).toEqual([
    "itx",
    "itx.kv",
    "itx.kv.get('a')",
  ]);
  expect(masked.itxExpressionRewriteRules["itx.kv"]).toEqual({
    match: ["itx", "kv"],
    target: null,
  });
  expect(
    reduceCoreEvent({
      event: at(6, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.kv",
        target: null,
      }),
      state: masked,
    }),
  ).toBeUndefined();
  expect(
    reduceCoreEvent({
      event: at(7, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.other",
        target: null,
      }),
      state: masked,
    }),
  ).toBeUndefined();
});

test("builtins root: the platform-equivalent target `itx.builtins.<match…>` DELETES the row (back to the platform row) — a mask, an override, or nothing at all", () => {
  const s = reduceAll([
    at(1, "events.iterate.com/itx/rewrite-rule-configured", { match: "itx.kv", target: null }),
    at(2, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.whoami",
      target: "itx.fake",
    }),
    at(3, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.kv",
      target: "itx.builtins.kv",
    }),
    at(4, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.whoami",
      target: "itx.builtins.whoami",
    }),
  ]);
  expect(s).toEqual(expect.objectContaining({ itxExpressionRewriteRules: {} }));
  expect(
    reduceCoreEvent({
      event: at(5, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.kv",
        target: "itx.builtins.kv",
      }),
      state: s,
    }),
  ).toBeUndefined();
  // a PINNED match's physical target is NOT the implicit row it sits under (`itx.ai`): it is a
  // grant of exactly that call and is STORED — what re-opens a prefix beneath a mask
  const pinned = reduceAll([
    at(1, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.ai.run('gpt-5')",
      target: "itx.fake",
    }),
    at(2, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.ai.run('gpt-5')",
      target: "itx.builtins.ai.run('gpt-5')",
    }),
  ]);
  expect(Object.keys(pinned.itxExpressionRewriteRules)).toEqual(["itx.ai.run('gpt-5')"]);
});

test("builtins root: HOSTING is decided on the RESOLVED target: the platform's spelling, a user's short spelling and a user's own rule naming `itx.facets` all host; the source is elided from the ORIGINAL spelling", () => {
  const specJson = JSON.stringify(SPEC);
  const s = reduceAll([
    at(1, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.hosts",
      target: "itx.facets",
    }),
    configured(2, "platform", `itx.builtins.facets.get('a', ${specJson}).processEventBatch`),
    configured(3, "short", `itx.facets.get('b', ${specJson}).processEventBatch`),
    configured(4, "viaRule", `itx.hosts.get('c', ${specJson}).processEventBatch`),
    configured(5, "address", "itx.facets.get('d').processEventBatch"),
  ]);
  expect(s.subscriptions.platform).toMatchObject({
    hostedFacet: { name: "a", className: "TallyDurableObject" },
  });
  expect(print(s.subscriptions.platform.target)).toBe(
    "itx.builtins.facets.get('a').processEventBatch",
  );
  expect(s.subscriptions.short).toMatchObject({
    hostedFacet: { name: "b", className: "TallyDurableObject" },
  });
  expect(print(s.subscriptions.short.target)).toBe("itx.facets.get('b').processEventBatch");
  expect(s.subscriptions.viaRule).toMatchObject({
    hostedFacet: { name: "c", className: "TallyDurableObject" },
  });
  expect(print(s.subscriptions.viaRule.target)).toBe("itx.hosts.get('c').processEventBatch"); // the caller's spelling, minus the source
  expect(s.subscriptions.address).not.toHaveProperty("hostedFacet");
  for (const row of Object.values(s.subscriptions))
    expect(JSON.stringify(row)).not.toContain("cap.js");
});

test("builtins root: a hosting target that cannot resolve yet (its rule comes later, or a mask sits on `itx.facets`) is stored as given and hosts nothing", () => {
  const specJson = JSON.stringify(SPEC);
  const s = reduceAll([
    configured(1, "early", `itx.later.get('e', ${specJson}).processEventBatch`),
    at(2, "events.iterate.com/itx/rewrite-rule-configured", {
      match: "itx.facets",
      target: null,
    }),
    configured(3, "masked", `itx.facets.get('f', ${specJson}).processEventBatch`),
  ]);
  expect(s.subscriptions.early).not.toHaveProperty("hostedFacet");
  expect(s.subscriptions.masked).not.toHaveProperty("hostedFacet");
});

// THE MARKER FOLLOWS THE RULES: every rule commit re-derives `hostedFacet` for every row that is not
// builtins-rooted, through the new table — the delivery loop re-resolves a target at every push, so
// the marker must name the facet the row would host NOW, or `processors.disable` would delete the
// wrong facet (or orphan one). A row the change leaves unresolvable keeps its marker, conservatively.
const facetF = "itx.builtins.facets.get('f',{source:{'cap.js':'x'},className:'F'})";
const facetG = "itx.builtins.facets.get('g',{source:{'cap.js':'y'},className:'G'})";
const markerRows: {
  rule: string;
  log: StreamEvent[];
  hosts: string | undefined;
  target?: string;
}[] = [
  {
    rule: "a rule configured AFTER the row makes the row host that facet",
    log: [configured(1, "s", "itx.proc.processEventBatch"), rule(2, "itx.proc", facetF)],
    hosts: "f",
  },
  {
    rule: "a rule RE-POINTED after the row moves the marker",
    log: [
      rule(1, "itx.proc", facetF),
      configured(2, "s", "itx.proc.processEventBatch"),
      rule(3, "itx.proc", facetG),
    ],
    hosts: "g",
  },
  {
    rule: "a rule REMOVED leaves the row unresolvable — the marker is kept, across later table changes",
    log: [
      rule(1, "itx.proc", facetF),
      configured(2, "s", "itx.proc.processEventBatch"),
      rule(3, "itx.proc", null),
      rule(4, "itx.other", "itx.builtins.kv"),
    ],
    hosts: "f",
  },
  {
    rule: "a rule re-pointed AWAY from `itx.builtins.facets` drops the marker",
    log: [
      rule(1, "itx.proc", facetF),
      configured(2, "s", "itx.proc.processEventBatch"),
      rule(3, "itx.proc", "itx.builtins.kv"),
    ],
    hosts: undefined,
  },
  {
    rule: "a row whose OWN target carried the spec (elided at configure) keeps its marker across rule commits",
    log: [
      configured(1, "s", `${facetF.replace("itx.builtins.", "itx.")}.processEventBatch`),
      rule(2, "itx.unrelated", "itx.builtins.kv"),
    ],
    hosts: "f",
    target: "itx.facets.get('f').processEventBatch",
  },
  {
    rule: "a platform-written (builtins-rooted, elided) row is untouched by rule commits",
    log: [
      configured(1, "s", `${facetF}.processEventBatch`),
      rule(2, "itx.facets", "itx.builtins.kv"),
    ],
    hosts: "f",
  },
];
test.for(markerRows)("the marker follows the rules: $rule", ({ log, hosts, target }) => {
  const s = reduceAll(log);
  expect(s.subscriptions.s.hostedFacet?.name).toBe(hosts);
  if (target) expect(print(s.subscriptions.s.target)).toBe(target);
});

// ── which facets a row PUSHES — what a facet is told as it starts (`fedByPushes`) ──

const pushedRows: { row: string; log: StreamEvent[]; pushesF: boolean }[] = [
  {
    row: "a processor row in the platform's spelling (its source elided at configure)",
    log: [configured(1, "p", `${facetF}.processEventBatch`)],
    pushesF: true,
  },
  {
    row: "the caller's short spelling, an address with no spec",
    log: [configured(1, "p", "itx.facets.get('f').processEventBatch")],
    pushesF: true,
  },
  {
    row: "a row through a rule of the caller's that names the facet",
    log: [rule(1, "itx.proc", facetF), configured(2, "s", "itx.proc.processEventBatch")],
    pushesF: true,
  },
  {
    row: "a row pushing ANOTHER facet of this context",
    log: [configured(1, "p", `${facetG}.processEventBatch`)],
    pushesF: false,
  },
  {
    row: "a row that calls another method of the facet: the loop walks it, never pushes",
    log: [configured(1, "p", "itx.facets.get('f').fetch")],
    pushesF: false,
  },
  {
    row: "a row that walks PAST the facet to a member's processEventBatch: walked, never pushed",
    log: [configured(1, "p", "itx.facets.get('f').inner.processEventBatch")],
    pushesF: false,
  },
  {
    row: "a rule that turns the whole target, method included, into the push: the loop evaluates the head, which resolves nowhere",
    log: [
      rule(1, "itx.a.processEventBatch", `${facetF}.processEventBatch`),
      configured(2, "s", "itx.a.processEventBatch"),
    ],
    pushesF: false,
  },
  {
    row: "a row pushing another context's facet `f` (`cd` resolves past `builtins.facets`)",
    log: [configured(1, "p", "itx.cd('/other').facets.get('f').processEventBatch")],
    pushesF: false,
  },
  {
    row: "a halted row: the loop skips it until an operator resumes it",
    log: [
      configured(1, "p", "itx.facets.get('f').processEventBatch"),
      at(2, "events.iterate.com/itx/subscription-delivery-halted", {
        name: "p",
        afterOffset: 1,
        attempts: 1,
      }),
    ],
    pushesF: false,
  },
  {
    row: "a removed row",
    log: [configured(1, "p", "itx.facets.get('f').processEventBatch"), configured(2, "p", null)],
    pushesF: false,
  },
  {
    row: "a rule re-pointed away from the facet",
    log: [
      rule(1, "itx.proc", facetF),
      configured(2, "s", "itx.proc.processEventBatch"),
      rule(3, "itx.proc", facetG),
    ],
    pushesF: false,
  },
];
test.for(pushedRows)("facetIsPushedByARow: $row", ({ log, pushesF }) => {
  expect(facetIsPushedByARow(reduceAll(log), "f")).toBe(pushesF);
});

// ── the platform rows a null MASKS (kept) vs a plain delete ──

// Un-setting in the presence of a broader mask: the physical spelling beneath it is a GRANT through
// the wall and is stored, so exactly that prefix re-opens — what longest-match promises.
test("a platform-equivalent target beneath a broader mask re-opens exactly that prefix", () => {
  const s = reduceAll([rule(1, "itx.kv", null), rule(2, "itx.kv.get", "itx.builtins.kv.get")]);
  expect(Object.keys(s.itxExpressionRewriteRules).sort()).toEqual(["itx.kv", "itx.kv.get"]);
});

// ── subscriptions ── the subscriptions table's one COMMAND (a literal `subscription-configured` event, normalized at the append boundary by `normalizeControlEvent`)
// BUILDS the event the caller appends — a configure, a replace, or (target null) a removal; a refusal
// (a dotted name, the reserved `core`, a target not rooted at itx) THROWS on append, nothing
// appended. A subscription is PURE DATA — a name, a target expression stored in its parsed form,
// an optional `consumes` filter; nothing here knows HOW a target is served (subscription-delivery.ts
// decides that by evaluating it). The rows THEMSELVES are `core` state, read here from the real
// Stream's core reduced state, as the DO reads them; the reduce's own pins (replace / drop / halted
// / resumed) are above.

// ── configure — ONE event: set, replace, or remove ──

test("configure: builds ONE subscription-configured with the target STORED AS THE PARSED FORM; appended, the row's identity is that event's offset", () => {
  const { configure, events, rows } = setup();
  const event = configure({
    name: "tally",
    target: ["itx", "facets", ["get", "tally"], "processEventBatch"],
    consumes: ["mark", "tick"],
  });
  expect(event).toEqual({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "tally",
      target: ["itx", "facets", ["get", "tally"], "processEventBatch"], // the parsed form at rest — a target may carry a whole source as data
      consumes: ["mark", "tick"],
    },
  });
  expect(events).toHaveLength(1);
  expect(rows().tally).toMatchObject({ configuredAtOffset: events[0].offset });
});

test("configure: omits `consumes` from the payload when none was given", () => {
  const { configure } = setup();
  expect(configure({ name: "all", target: "itx.digest.processEventBatch" })).toEqual({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "all",
      target: ["itx", "digest", "processEventBatch"], // a string target is parsed ONCE, on append
    },
  });
});

test.each([
  {
    afterOffset: 0,
    becomes: "carried: { afterOffset: 0 } — the whole log",
    payloadHas: { afterOffset: 0 },
  },
  { afterOffset: 7, becomes: "carried: { afterOffset: 7 }", payloadHas: { afterOffset: 7 } },
  { afterOffset: undefined, becomes: "omitted from the payload and the row", payloadHas: {} },
])("configure: `afterOffset` $afterOffset is $becomes", ({ afterOffset, payloadHas }) => {
  const { configure, rows } = setup();
  const event = configure({ name: "h", target: "itx.digest.processEventBatch", afterOffset });
  expect(event).toEqual({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "h", target: ["itx", "digest", "processEventBatch"], ...payloadHas },
  });
  expect(rows()).toEqual({
    h: {
      target: ["itx", "digest", "processEventBatch"],
      configuredAtOffset: rows().h.configuredAtOffset,
      ...payloadHas,
    },
  });
});

test.each([-1, 1.5, Number.NaN, "0"])(
  "configure: an `afterOffset` that is not a non-negative integer (%s) is refused on append — a throw, nothing appended",
  (afterOffset) => {
    const { configure, events } = setup();
    expect(() =>
      configure({ name: "h", target: "itx.digest.f", afterOffset: afterOffset as number }),
    ).toThrow(/afterOffset is a non-negative integer/);
    expect(events).toHaveLength(0);
  },
);

test("configure: the SAME NAME REPLACES the row — target and filter of the newest configure, never a stack", () => {
  const { configure, events, rows } = setup();
  configure({ name: "w", target: "itx.a.processEventBatch", consumes: ["x"] });
  configure({ name: "w", target: "itx.b.processEventBatch" });
  expect(events).toHaveLength(2);
  expect(Object.keys(rows())).toEqual(["w"]);
  expect(print(rows().w.target)).toBe("itx.b.processEventBatch");
  expect(rows().w).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
  expect(rows().w).toMatchObject({ configuredAtOffset: events[1].offset });
});

test("configure: a HALTED row re-configured identically gets a fresh row that carries no halt", () => {
  const { configure, append, rows } = setup();
  configure({ name: "digest", target: "itx.digest.processEventBatch" });
  append("events.iterate.com/itx/subscription-delivery-halted", {
    name: "digest",
    afterOffset: 1,
    attempts: 15,
  });
  expect(rows().digest.halted).toBeDefined();
  configure({ name: "digest", target: "itx.digest.processEventBatch" });
  expect(rows().digest).not.toHaveProperty("halted");
});

test("configure: a NULL target is the removal: the same event, target null (and no consumes); an unknown name is a no-op through the reduce", () => {
  const { configure, events, rows } = setup();
  configure({ name: "tab", target: "itx.rpcStubs.get('subscription:tab')" });
  expect(configure({ name: "tab", target: null, consumes: ["ignored"] })).toEqual({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "tab", target: null },
  });
  expect(rows()).toEqual({});
  configure({ name: "never-there", target: null });
  expect(events).toHaveLength(3);
  expect(rows()).toEqual({});
});

test("configure: the target must be rooted at `itx` (a bare built-in root is unspellable) — a throw, nothing appended", () => {
  const { configure, events } = setup();
  expect(() => configure({ name: "evil", target: "kv.get('a')" })).toThrow(
    /must be rooted at "itx"/,
  );
  expect(() => configure({ name: "evil", target: ["kv", ["get", "a"]] })).toThrow(
    /must be rooted at "itx"/,
  );
  expect(events).toHaveLength(0);
});

test("configure: a name is ONE segment, [A-Za-z0-9_-]+, never a key of Object.prototype and never `core` — a dotted, spaced, `__proto__`, `constructor` or `core` name is refused on append, nothing appended", () => {
  const { configure, events } = setup();
  expect(() => configure({ name: "a.b", target: "itx.whoami" })).toThrow(/one segment/);
  expect(() => configure({ name: "has space", target: "itx.whoami" })).toThrow(/one segment/);
  expect(() => configure({ name: "a.b", target: null })).toThrow(/one segment/);
  // a key of Object.prototype would name the table's prototype, never a row
  expect(() => configure({ name: "__proto__", target: "itx.whoami" })).toThrow(/Object.prototype/);
  expect(() => configure({ name: "constructor", target: "itx.whoami" })).toThrow(
    /Object.prototype/,
  );
  // the always-on core reduce is addressable as a facet, never a configurable subscription — a
  // row named `core` would be undeliverable and climb the retry ladder to a halt
  expect(() => configure({ name: "core", target: "itx.whoami" })).toThrow(/reserved/);
  expect(() => configure({ name: "core", target: null })).toThrow(/reserved/);
  expect(events).toHaveLength(0);
});

test("configure: the stored target IS the parsed form: an array target is stored as given (shape-checked, never printed) and the row reduces to it — so the reserved literal `{ '@': true }` is DATA here (the markers belong to a rule's target only)", () => {
  const { configure, rows } = setup();
  const targets: ItxExpression[] = [
    ["itx", "facets", ["get", { "a b": 1e21 }], "processEventBatch"],
    ["itx", "x", ["y", { "@": true }]],
  ];
  for (const [i, target] of targets.entries()) {
    const event = configure({ name: `odd${i}`, target });
    expect(event).toEqual({
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name: `odd${i}`, target },
    });
    expect(rows()[`odd${i}`]).toEqual(expect.objectContaining({ target }));
  }
});

// ── rule 8 at a CHILD (nothing project-level implicit; the bare null; the grant through the wall) ──

test("rule 8 at a child: a project root's physical target at a child is a GRANT and is stored; a context root's is the default and deletes", () => {
  const s = reduceAll([
    atChild(1, { match: "itx.kv", target: "itx.builtins.kv" }),
    atChild(2, { match: "itx.append", target: "itx.builtins.append" }),
  ]);
  expect(Object.keys(s.itxExpressionRewriteRules)).toEqual(["itx.kv"]);
});
test("rule 8 at a child: `null` at a project root's name at a child deletes (nothing implicit beneath); at a context root's it masks; the bare null is kept", () => {
  const s = reduceAll([
    atChild(1, { match: "itx.kv", target: null }),
    atChild(2, { match: "itx.append", target: null }),
    atChild(3, { match: "itx", target: null }),
  ]);
  expect(Object.keys(s.itxExpressionRewriteRules).sort()).toEqual(["itx", "itx.append"]);
});
test("rule 8 at a child: `null` at a name a stored SHORTER row with a target would answer — the parent link, a granted root — is KEPT as a mask (the chain is cut there); without that row it deletes", () => {
  const linked = reduceAll([
    atChild(1, { match: "itx", target: "itx.builtins.cd('/')" }),
    atChild(2, { match: "itx.tool", target: null }),
    atChild(3, { match: "itx.repos", target: "itx.builtins.cd('/').repos" }),
    atChild(4, { match: "itx.repos.get('secret')", target: null }),
  ]);
  expect(Object.keys(linked.itxExpressionRewriteRules).sort()).toEqual([
    "itx",
    "itx.repos",
    "itx.repos.get('secret')",
    "itx.tool",
  ]);
  expect(linked.itxExpressionRewriteRules["itx.tool"]).toMatchObject({ target: null });
  const unlinked = reduceAll([atChild(1, { match: "itx.tool", target: null })]);
  expect(unlinked).toEqual(expect.objectContaining({ itxExpressionRewriteRules: {} }));
});
test("rule 8 at a child: behind a bare null the physical spelling of a context root is the grant through the wall and is STORED; a description rides the row", () => {
  const s = reduceAll([
    atChild(1, { match: "itx", target: null, description: "a jail" }),
    atChild(2, {
      match: "itx.readEvents",
      target: "itx.builtins.readEvents",
      description: "your history",
    }),
  ]);
  expect(s.itxExpressionRewriteRules["itx.readEvents"]).toMatchObject({
    target: ["itx", "builtins", "readEvents"],
    description: "your history",
  });
  expect(s.itxExpressionRewriteRules["itx"]).toMatchObject({
    target: null,
    description: "a jail",
  });
});

/** A committed DURABLE event at `offset`; createdAt derives from the offset so identity pins read. */
function at(offset: number, type: string, payload?: Record<string, unknown>): StreamEvent {
  return { type, payload, offset, createdAt: new Date(offset * 1000).toISOString(), path: "/" };
}

function reduceAll(events: StreamEvent[], initial = CoreContract.initialState()): CoreState {
  return events.reduce((s, e) => reduceCoreEvent({ event: e, state: s }) ?? s, initial);
}

function requested(offset: number) {
  return at(offset, "events.iterate.com/itx/run-requested", { code: "async (itx) => 1" });
}

function settled(offset: number, requestOffset: number) {
  return at(offset, "events.iterate.com/itx/run-settled", {
    requestOffset,
    settlement: { status: "succeeded", result: 1 },
  });
}

/** A durable subscription-configured for `name` (default target: a plain method). */
function configured(offset: number, name: string, target: string | null = "itx.x.f"): StreamEvent {
  return at(offset, "events.iterate.com/itx/subscription-configured", { name, target });
}

/** A durable rewrite-rule-configured for `match`. */
function rule(offset: number, match: string, target: string | null): StreamEvent {
  return at(offset, "events.iterate.com/itx/rewrite-rule-configured", { match, target });
}

/** The payload of route `route-<n>`: requests on routing slug `s<n>` go to `itx.t<n>`. */
function numberedRoute(n: number) {
  return {
    fetchRouteName: `route-${n}`,
    requestMatcher: { routingSlug: `s${n}` },
    target: ["itx", `t${n}`],
  };
}

function onError(error: unknown, event: StreamEvent) {
  throw new Error(`unexpected reduce error at ${event.offset}: ${String(error)}`);
}

/** A rewrite-rule-configured committed at the child context `/agents/a`. */
function atChild(offset: number, payload: Record<string, unknown>): StreamEvent {
  return {
    ...at(offset, "events.iterate.com/itx/rewrite-rule-configured", payload),
    path: "/agents/a",
  };
}

function setup() {
  const { stream, events } = nodeSqliteStream();
  /** The edge's `subscribe`: build the event, append it. */
  const configure = (input: {
    name: string;
    target: ItxExpressionInput | null;
    consumes?: string[];
    afterOffset?: number;
  }) => {
    const event = normalizeControlEvent(
      {
        type: "events.iterate.com/itx/subscription-configured",
        payload: input,
      },
      "/",
    );
    stream.append(event);
    return event;
  };
  /** Append a raw event as the stream would — a fact the delivery loop appends (`delivery-halted`
   *  has no command in this module). */
  const append = (type: string, payload: Record<string, unknown>) =>
    stream.append({ type, payload })[0];
  return { events, rows: () => stream.coreReducedState.subscriptions, configure, append };
}
