// The core reduce's executable spec (src/stream/core-processor.ts): ONE pure reduce of the context's
// nine control events into the state the DO reads SYNCHRONOUSLY at its doors — identity (created),
// incarnation (woken), the pause latch (paused/resumed), the itx-expression rewrite rules (a MAP by
// match: configured sets or, with a null target, deletes), the subscriptions table (by name:
// configured REPLACES or, with a null target, drops; delivery-halted marks, delivery-resumed clears
// the halt and records the seek) and the secrets catalog (names + origins, never a value). No clock, no effects: the same log always reduces to the same state, an ephemeral
// event never reduces (the checkpoint must rebuild from the durable log alone), and a malformed
// hand-appended event THROWS at the reduce — the host contains it (stream.test.ts pins the skip). The DOORS that build these events are pinned beside their modules
// (context/itx-expression-rewriting.test.ts, the subscriptions section below).
import { describe, expect, test } from "vitest";
import {
  parse,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "../context/expression.ts";
import {
  CoreContract,
  reduceCoreEvent,
  reduceCoreEventBatch,
  type CoreState,
  type Subscription,
  normalizeControlEvent,
} from "./core-processor.ts";
import type { StreamEvent } from "./processor.ts";
import { memoryStream } from "./test-support.ts";

/** A committed DURABLE event at `offset`; createdAt derives from the offset so identity pins read. */
const at = (offset: number, type: string, payload?: Record<string, unknown>): StreamEvent => ({
  type,
  ...(payload && { payload }),
  offset,
  createdAt: new Date(offset * 1000).toISOString(),
  path: "/",
});
const reduceAll = (events: StreamEvent[], initial = CoreContract.initialState()): CoreState =>
  events.reduce((s, e) => reduceCoreEvent({ event: e, state: s }) ?? s, initial);

describe("the contract", () => {
  test("slug `core` v8.0.0; the every-field-defaulted initial state", () => {
    expect(CoreContract.slug).toBe("core");
    expect(CoreContract.version).toBe("8.0.0");
    expect(CoreContract.initialState()).toEqual({
      paused: null,
      itxExpressionRewriteRules: {},
      subscriptions: {},
      secrets: {},
    });
  });
});

describe("identity, incarnation, the pause latch", () => {
  test("created → projectId, path, createdAt (the birth certificate's own timestamp)", () => {
    const born = at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" });
    const s = reduceAll([born]);
    expect(s.projectId).toBe("prj_t");
    expect(s.path).toBe("/");
    expect(s.createdAt).toBe(born.createdAt);
  });

  test("woken → incarnation; every wake overwrites (growth across idle is the hibernation tell); identity untouched", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" }),
      at(2, "events.iterate.com/stream/woken", { incarnation: 1 }),
      at(3, "events.iterate.com/stream/woken", { incarnation: 2 }),
    ]);
    expect(s.incarnation).toBe(2);
    expect(s.projectId).toBe("prj_t");
  });

  test("pause is a latch: paused → resumed round-trips; reason carried", () => {
    const paused = reduceAll([
      at(1, "events.iterate.com/stream/paused", { reason: "maintenance" }),
    ]);
    expect(paused.paused).toEqual({ reason: "maintenance" });
    expect(reduceAll([at(2, "events.iterate.com/stream/resumed")], paused).paused).toBeNull();
  });

  test('paused without a reason defaults to "paused" in the reduce (the state guarantee)', () => {
    expect(reduceAll([at(1, "events.iterate.com/stream/paused")]).paused).toEqual({
      reason: "paused",
    });
    expect(reduceAll([at(1, "events.iterate.com/stream/paused", {})]).paused).toEqual({
      reason: "paused",
    });
  });
});

describe("the rewrite-rule table — a MAP by match", () => {
  test("configured sets a PARSED rule (string at rest, structured in state) under its canonical match", () => {
    const s = reduceAll([
      at(7, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.db",
        target: "itx.facets.get('tab-1')",
      }),
    ]);
    expect(s.itxExpressionRewriteRules).toEqual({
      "itx.db": { match: ["itx", "db"], target: parse("itx.facets.get('tab-1')") },
    });
  });

  test("the SAME match REPLACES (a map, never a stack); a null target DELETES exactly that match; null on nothing → undefined (keep the state)", () => {
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

  test("a malformed configured (a match with an argless call step, an unbalanced target) THROWS at the reduce — the host skips it (stream.test.ts); a well-formed one still reduces", () => {
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

  test("a removal with `ifTarget` (a handle's undo) applies only while the row's target is still that — a replacement survives a stale undo, identity kept; a mask's undo names `null`", () => {
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
    expect(
      reduceCoreEvent({ event: remove(3, parse("itx.tab1")), state: replaced }),
    ).toBeUndefined();
    // the row's own handle removes it
    expect(reduceAll([remove(3, parse("itx.tab2"))], replaced).itxExpressionRewriteRules).toEqual(
      {},
    );
    // an undo over a row that is already gone: a no-op too
    expect(
      reduceCoreEvent({ event: remove(4, parse("itx.tab2")), state: CoreContract.initialState() }),
    ).toBeUndefined();
    // a MASK's handle undoes with `ifTarget: null` — lifting the mask, never someone else's rewrite
    const masked = reduceAll([configure(1, null)]);
    expect(reduceAll([remove(2, null)], masked).itxExpressionRewriteRules).toEqual({});
    const rewritten = reduceAll([configure(1, null), configure(2, "itx.tab1")]);
    expect(reduceCoreEvent({ event: remove(3, null), state: rewritten })).toBeUndefined();
  });
});

describe("the subscriptions table — by name", () => {
  test("configured: a row is `{ target (parsed), consumes?, configuredAtOffset }` — the event's own offset is its identity", () => {
    const e = at(3, "events.iterate.com/stream/subscription-configured", {
      name: "tab",
      target: "itx.rpcStubs.get('subscription:tab')",
      consumes: ["mark"],
    });
    expect(reduceAll([e]).subscriptions).toEqual({
      tab: {
        target: parse("itx.rpcStubs.get('subscription:tab')"),
        consumes: ["mark"],
        configuredAtOffset: 3,
      },
    });
  });

  test("configured with `afterOffset` stores it on the row (where the cursor lane starts — 0 = the whole log); without it, no key at all (= from the configure offset)", () => {
    const s = reduceAll([
      at(4, "events.iterate.com/stream/subscription-configured", {
        name: "history",
        target: "itx.digest.processEventBatch",
        afterOffset: 0,
      }),
      at(5, "events.iterate.com/stream/subscription-configured", {
        name: "now",
        target: "itx.digest.processEventBatch",
      }),
    ]);
    expect(s.subscriptions.history).toMatchObject({ configuredAtOffset: 4, afterOffset: 0 });
    expect(s.subscriptions.now).not.toHaveProperty("afterOffset");
  });

  test("configured without `consumes` stores no `consumes` key at all (absent = every durable event)", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "all",
        target: "itx.facets.get('tally').processEventBatch",
      }),
    ]);
    expect(s.subscriptions.all).not.toHaveProperty("consumes");
  });

  test("configured with the SAME NAME REPLACES the row — no shadow stack, the old target and filter are gone", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.old.processEventBatch",
        consumes: ["a"],
      }),
      at(2, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.new.processEventBatch",
      }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["digest"]);
    expect(print(s.subscriptions.digest.target)).toBe("itx.new.processEventBatch");
    expect(s.subscriptions.digest.configuredAtOffset).toBe(2);
    expect(s.subscriptions.digest).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
  });

  test("configured with a NULL target drops the row; dropping an unknown name → undefined (keep the state), never a throw or a phantom row", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", { name: "a", target: "itx.x.f" }),
      at(2, "events.iterate.com/stream/subscription-configured", { name: "b", target: "itx.y.f" }),
      at(3, "events.iterate.com/stream/subscription-configured", { name: "a", target: null }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["b"]);
    expect(
      reduceCoreEvent({
        event: at(4, "events.iterate.com/stream/subscription-configured", {
          name: "ghost",
          target: null,
        }),
        state: s,
      }),
    ).toBeUndefined();
  });

  test("a null target with `ifConfiguredAtOffset` (a handle's undo) drops only the row configured at that offset — a same-name replace survives the stale undo, identity kept", () => {
    const configure = (offset: number) =>
      at(offset, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.digest.processEventBatch",
      });
    const remove = (offset: number, ifConfiguredAtOffset: number) =>
      at(offset, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: null,
        ifConfiguredAtOffset,
      });
    const replaced = reduceAll([configure(1), configure(2)]);
    expect(reduceCoreEvent({ event: remove(3, 1), state: replaced })).toBeUndefined(); // the first handle's stale undo
    expect(reduceAll([remove(3, 2)], replaced).subscriptions).toEqual({}); // the row's own handle
    expect(
      reduceCoreEvent({ event: remove(4, 2), state: CoreContract.initialState() }),
    ).toBeUndefined(); // already gone
  });

  test("delivery-halted sets `halted { afterOffset, attempts, error? }` on the row (the loop's fact); unknown name → no-op", () => {
    const configured = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.digest.processEventBatch",
      }),
    ]);
    const halted = reduceAll(
      [
        at(2, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "digest",
          afterOffset: 7,
          attempts: 15,
          error: "boom",
        }),
      ],
      configured,
    );
    expect(halted.subscriptions.digest.halted).toEqual({
      afterOffset: 7,
      attempts: 15,
      error: "boom",
    });
    // without `error` the key is absent, not undefined-valued
    const rehalted = reduceAll(
      [
        at(3, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "digest",
          afterOffset: 9,
          attempts: 1,
        }),
      ],
      halted,
    );
    expect(rehalted.subscriptions.digest.halted).toEqual({ afterOffset: 9, attempts: 1 });
    // a halt for a name that has no row is dropped on the floor
    expect(
      reduceCoreEvent({
        event: at(4, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "nobody",
          afterOffset: 1,
          attempts: 1,
        }),
        state: rehalted,
      }),
    ).toBeUndefined();
  });

  test("delivery-resumed CLEARS `halted` and records `resumed { afterOffset?, atOffset }` — atOffset is the resume event's own offset; unknown name → no-op", () => {
    const halted = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.digest.processEventBatch",
      }),
      at(2, "events.iterate.com/stream/subscription-delivery-halted", {
        name: "digest",
        afterOffset: 7,
        attempts: 15,
      }),
    ]);
    const sought = reduceAll(
      [
        at(3, "events.iterate.com/stream/subscription-delivery-resumed", {
          name: "digest",
          afterOffset: 8,
        }),
      ],
      halted,
    );
    expect(sought.subscriptions.digest).not.toHaveProperty("halted");
    expect(sought.subscriptions.digest.resumed).toEqual({ afterOffset: 8, atOffset: 3 });
    // a plain un-halt (no seek): `resumed` carries only the generation
    const plain = reduceAll(
      [at(4, "events.iterate.com/stream/subscription-delivery-resumed", { name: "digest" })],
      sought,
    );
    expect(plain.subscriptions.digest.resumed).toEqual({ atOffset: 4 });
    // and it keeps the row's other fields intact
    expect(print(plain.subscriptions.digest.target)).toBe("itx.digest.processEventBatch");
    expect(plain.subscriptions.digest.configuredAtOffset).toBe(1);
    expect(
      reduceCoreEvent({
        event: at(5, "events.iterate.com/stream/subscription-delivery-resumed", { name: "nobody" }),
        state: plain,
      }),
    ).toBeUndefined();
  });

  test("a malformed target THROWS at the reduce (no row) — the host skips it (stream.test.ts); a well-formed one still reduces", () => {
    expect(() =>
      reduceCoreEvent({
        event: at(1, "events.iterate.com/stream/subscription-configured", {
          name: "broken",
          target: "itx.broken(", // does not parse
        }),
        state: CoreContract.initialState(),
      }),
    ).toThrow();
    const s = reduceAll([
      at(2, "events.iterate.com/stream/subscription-configured", {
        name: "fine",
        target: "itx.whoami",
      }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["fine"]);
  });
});

describe("purity", () => {
  test("an EPHEMERAL event is never reduced, whatever its type — the state is rebuildable from the durable log alone", () => {
    const state = CoreContract.initialState();
    const ephemeral = (type: string, payload: Record<string, unknown>): StreamEvent => ({
      ...at(1, type, payload),
      ephemeral: true,
    });
    for (const e of [
      ephemeral("events.iterate.com/stream/created", { projectId: "p", path: "/" }),
      ephemeral("events.iterate.com/stream/woken", { incarnation: 9 }),
      ephemeral("events.iterate.com/stream/paused", { reason: "x" }),
      ephemeral("events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.blip",
        target: "itx.kv",
      }),
      ephemeral("events.iterate.com/stream/subscription-configured", {
        name: "blip",
        target: "itx.whoami",
      }),
    ])
      expect(reduceCoreEvent({ event: e, state })).toBeUndefined();
  });

  test("an event the reduce does not know → undefined (keep the state)", () => {
    expect(
      reduceCoreEvent({ event: at(1, "work"), state: CoreContract.initialState() }),
    ).toBeUndefined();
  });

  // `reduceCoreEventBatch` is the host's door (Stream reduces a commit's fresh events and each page of the
  // constructor's re-reduce through it): each core table is copied ONCE per batch and mutated as a
  // draft after — O(rows + events), not O(rows × events) (memory-budget.test.ts pins the time). What
  // that must NOT cost is purity at the batch's edges: the state handed in stays what it was.
  describe("reduceCoreEventBatch — a batch's draft tables never leak into the state it was given", () => {
    const configured = (
      offset: number,
      name: string,
      target: string | null = "itx.x.f",
    ): StreamEvent =>
      at(offset, "events.iterate.com/stream/subscription-configured", { name, target });
    const rule = (offset: number, match: string, target: string | null): StreamEvent =>
      at(offset, "events.iterate.com/itx/rewrite-rule-configured", { match, target });
    const onError = (error: unknown, event: StreamEvent) => {
      throw new Error(`unexpected reduce error at ${event.offset}: ${String(error)}`);
    };

    test("a batch folds to exactly the per-event fold; the input state and its tables are untouched — and a second batch over the result leaves the first result untouched too", () => {
      const first = [configured(1, "a"), rule(2, "itx.x", "itx.kv"), configured(3, "b")];
      const second = [
        configured(4, "a", "itx.y.f"),
        rule(5, "itx.x", null),
        configured(6, "b", null),
      ];
      const initial = CoreContract.initialState();
      const afterFirst = reduceCoreEventBatch(first, initial, onError);
      expect(afterFirst).toEqual(reduceAll(first));
      expect(initial).toEqual(CoreContract.initialState()); // the given state: not a row leaked into it
      const afterFirstSnapshot = JSON.parse(JSON.stringify(afterFirst));
      const afterSecond = reduceCoreEventBatch(second, afterFirst, onError);
      expect(afterSecond).toEqual(reduceAll([...first, ...second]));
      expect(afterFirst).toEqual(afterFirstSnapshot); // the previous batch's result: immutable
      expect(afterSecond.subscriptions).not.toBe(afterFirst.subscriptions); // a fresh draft, not a shared table
      expect(afterSecond.itxExpressionRewriteRules).not.toBe(afterFirst.itxExpressionRewriteRules);
    });

    test("a batch that touches nothing hands the SAME state back (identity is the host's change signal — no checkpoint rewrite, no live delta)", () => {
      const state = reduceCoreEventBatch(
        [configured(1, "a")],
        CoreContract.initialState(),
        onError,
      );
      expect(
        reduceCoreEventBatch(
          [at(2, "work"), { ...configured(3, "z"), ephemeral: true }],
          state,
          onError,
        ),
      ).toBe(state);
    });

    test("a throwing event is handed to onError and SKIPPED — the events after it still reduce, and its state is the previous event's", () => {
      const reported: number[] = [];
      const state = reduceCoreEventBatch(
        [configured(1, "a"), rule(2, "itx.call()", "itx.kv"), configured(3, "b")],
        CoreContract.initialState(),
        (_error, event) => void reported.push(event.offset),
      );
      expect(reported).toEqual([2]);
      expect(Object.keys(state.subscriptions)).toEqual(["a", "b"]);
      expect(state.itxExpressionRewriteRules).toEqual({});
    });
  });

  test("the reduce rebuilds bit-identically from the log (pure — no wall clock anywhere)", () => {
    const log = [
      at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" }),
      at(2, "events.iterate.com/stream/woken", { incarnation: 1 }),
      at(3, "events.iterate.com/itx/rewrite-rule-configured", {
        match: "itx.db",
        target: "itx.kv",
      }),
      at(4, "events.iterate.com/stream/subscription-configured", {
        name: "tally",
        target: "itx.facets.get('tally').processEventBatch",
      }),
      at(5, "events.iterate.com/stream/paused", { reason: "r" }),
      at(6, "events.iterate.com/stream/resumed"),
      at(7, "events.iterate.com/stream/woken", { incarnation: 2 }),
    ];
    expect(reduceAll(log)).toEqual(reduceAll(log));
  });
});

describe("the builtins root, as the reduce sees it: masks, the platform-equivalent target, hosting on the RESOLVED target", () => {
  const SPEC = { source: { "cap.js": "export class T {}" }, className: "TallyDurableObject" };
  const configured = (offset: number, name: string, target: string) =>
    at(offset, "events.iterate.com/stream/subscription-configured", { name, target });

  test("`null` at a built-in's name is KEPT as a mask row; `null` at a plain name deletes; a repeat of either is a no-op (undefined)", () => {
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

  test("the platform-equivalent target `itx.builtins.<match…>` DELETES the row (back to the platform row) — a mask, an override, or nothing at all", () => {
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
    expect(s.itxExpressionRewriteRules).toEqual({});
    expect(
      reduceCoreEvent({
        event: at(5, "events.iterate.com/itx/rewrite-rule-configured", {
          match: "itx.kv",
          target: "itx.builtins.kv",
        }),
        state: s,
      }),
    ).toBeUndefined();
    // a pinned match's equivalent carries the pin
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
    expect(pinned.itxExpressionRewriteRules).toEqual({});
  });

  test("HOSTING is decided on the RESOLVED target: the platform's spelling, a user's short spelling and a user's own rule naming the door all host; the source is elided from the ORIGINAL spelling", () => {
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

  test("a hosting target that cannot resolve yet (its rule comes later, or a mask sits on the door) is stored as given and hosts nothing", () => {
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
  const RULE = "events.iterate.com/itx/rewrite-rule-configured";
  const facetF = "itx.builtins.facets.get('f',{source:{'cap.js':'x'},className:'F'})";
  const facetG = "itx.builtins.facets.get('g',{source:{'cap.js':'y'},className:'G'})";
  const rows: { rule: string; log: StreamEvent[]; hosts: string | undefined; target?: string }[] = [
    {
      rule: "a rule configured AFTER the row makes the row host that facet",
      log: [
        configured(1, "s", "itx.proc.processEventBatch"),
        at(2, RULE, { match: "itx.proc", target: facetF }),
      ],
      hosts: "f",
    },
    {
      rule: "a rule RE-POINTED after the row moves the marker",
      log: [
        at(1, RULE, { match: "itx.proc", target: facetF }),
        configured(2, "s", "itx.proc.processEventBatch"),
        at(3, RULE, { match: "itx.proc", target: facetG }),
      ],
      hosts: "g",
    },
    {
      rule: "a rule REMOVED leaves the row unresolvable — the marker is kept, across later table changes",
      log: [
        at(1, RULE, { match: "itx.proc", target: facetF }),
        configured(2, "s", "itx.proc.processEventBatch"),
        at(3, RULE, { match: "itx.proc", target: null }),
        at(4, RULE, { match: "itx.other", target: "itx.builtins.kv" }),
      ],
      hosts: "f",
    },
    {
      rule: "a rule re-pointed AWAY from the facets door drops the marker",
      log: [
        at(1, RULE, { match: "itx.proc", target: facetF }),
        configured(2, "s", "itx.proc.processEventBatch"),
        at(3, RULE, { match: "itx.proc", target: "itx.builtins.kv" }),
      ],
      hosts: undefined,
    },
    {
      rule: "a row whose OWN target carried the spec (elided at configure) keeps its marker across rule commits",
      log: [
        configured(1, "s", `${facetF.replace("itx.builtins.", "itx.")}.processEventBatch`),
        at(2, RULE, { match: "itx.unrelated", target: "itx.builtins.kv" }),
      ],
      hosts: "f",
      target: "itx.facets.get('f').processEventBatch",
    },
    {
      rule: "a platform-written (builtins-rooted, elided) row is untouched by rule commits",
      log: [
        configured(1, "s", `${facetF}.processEventBatch`),
        at(2, RULE, { match: "itx.facets", target: "itx.builtins.kv" }),
      ],
      hosts: "f",
    },
  ];
  for (const { rule, log, hosts, target } of rows)
    test(`the marker follows the rules: ${rule}`, () => {
      const s = reduceAll(log);
      expect(s.subscriptions.s.hostedFacet?.name).toBe(hosts);
      if (target) expect(print(s.subscriptions.s.target)).toBe(target);
    });
});

describe("the secrets catalog — by name, the origin only, never a value", () => {
  const changed = (offset: number, payload: Record<string, unknown>) =>
    at(offset, "events.iterate.com/secrets/changed", payload);
  // `identity` is what the LAST event's reduce hands back: a new state, or `undefined` — the host's
  // change signal (no checkpoint rewrite, no live delta) for a no-op.
  const rows: {
    title: string;
    events: StreamEvent[];
    becomes: CoreState["secrets"];
    identity: "a new state" | "undefined (a no-op)";
  }[] = [
    {
      title: "a set",
      events: [changed(1, { name: "a" })],
      becomes: { a: {} },
      identity: "a new state",
    },
    {
      title: "a set with an origin",
      events: [changed(1, { name: "a", origin: "https://api.example.com" })],
      becomes: { a: { origin: "https://api.example.com" } },
      identity: "a new state",
    },
    {
      title: "a re-set REPLACES (the origin can be dropped)",
      events: [
        changed(1, { name: "a", origin: "https://api.example.com" }),
        changed(2, { name: "a" }),
      ],
      becomes: { a: {} },
      identity: "a new state",
    },
    {
      title: "a re-set with the SAME origin is a no-op",
      events: [
        changed(1, { name: "a", origin: "https://api.example.com" }),
        changed(2, { name: "a", origin: "https://api.example.com" }),
      ],
      becomes: { a: { origin: "https://api.example.com" } },
      identity: "undefined (a no-op)",
    },
    {
      title: "a delete removes",
      events: [changed(1, { name: "a" }), changed(2, { name: "a", deleted: true })],
      becomes: {},
      identity: "a new state",
    },
    {
      title: "deleting what is not there is a no-op",
      events: [
        changed(1, { name: "a" }),
        changed(2, { name: "a", deleted: true }),
        changed(3, { name: "b", deleted: true }),
      ],
      becomes: {},
      identity: "undefined (a no-op)",
    },
  ];
  for (const { title, events, becomes, identity } of rows)
    test(`${title} — the last reduce returns ${identity}`, () => {
      const before = reduceAll(events.slice(0, -1));
      const out = reduceCoreEvent({ event: events.at(-1)!, state: before });
      expect(out === undefined ? "undefined (a no-op)" : "a new state").toBe(identity);
      expect((out ?? before).secrets).toEqual(becomes);
    });
});

describe("the platform rows a null MASKS (kept) vs a plain delete", () => {
  const configured = (offset: number, match: string, target: string | null) =>
    at(offset, "events.iterate.com/itx/rewrite-rule-configured", { match, target });
  test("`itx.worker ⇒ null` is KEPT as a mask — the resolver's default config worker is a platform row, so a project that says no must not fall back to the no-op silently", () => {
    const s = reduceAll([configured(1, "itx.worker", "itx.kv"), configured(2, "itx.worker", null)]);
    expect(s.itxExpressionRewriteRules["itx.worker"]).toEqual({
      match: ["itx", "worker"],
      target: null,
    });
    // a name with no platform row beneath is simply deleted
    const gone = reduceAll([configured(1, "itx.mine", "itx.kv"), configured(2, "itx.mine", null)]);
    expect(gone.itxExpressionRewriteRules).toEqual({});
  });

  // RED (`test.fails` — a known defect, too costly to fix now): the platform-equivalent target
  // `itx.<x…> ⇒ itx.builtins.<x…>` is DELETED whatever lies above it, so under a broader mask
  // (`itx ⇒ null`, `itx.kv ⇒ null`) one prefix can never be re-opened — yet longest-match promises
  // it. The fix stores the row when a shorter row claims the prefix and deletes only when nothing
  // lies above — a table-aware delete.
  test.fails("a platform-equivalent target beneath a broader mask re-opens exactly that prefix", () => {
    const s = reduceAll([
      configured(1, "itx.kv", null),
      configured(2, "itx.kv.get", "itx.builtins.kv.get"),
    ]);
    expect(Object.keys(s.itxExpressionRewriteRules).sort()).toEqual(["itx.kv", "itx.kv.get"]);
  });
});

// ── subscriptions ── the subscriptions table's one COMMAND (a literal `subscription-configured` event, normalized at the append boundary by `normalizeControlEvent`)
// BUILDS the event the caller appends — a configure, a replace, or (target null) a removal; a refusal
// (a dotted name, a target not rooted at itx) THROWS at the door, nothing appended (the reserved
// `core` is the APPEND door's refusal — stream.test.ts). A subscription is PURE DATA — a name, a target expression stored as its printed string,
// an optional `consumes` filter; nothing here knows HOW a target is served (subscription-delivery.ts
// decides that by evaluating it). The rows THEMSELVES are `core` state, reduced here through
// `reduceCoreEvent` exactly as the DO does; the reduce's own pins (replace / drop / halted /
// resumed) live in core-processor.test.ts.

const setup = () => {
  const { stream, events } = memoryStream();
  // INLINE, exactly like the DO: the rows are core state, reduced from the durable log per call.
  const rows = (): Record<string, Subscription> =>
    events.reduce(
      (st, e) => reduceCoreEvent({ event: e, state: st }) ?? st,
      CoreContract.initialState(),
    ).subscriptions;
  /** The edge's `subscribe`: build the event, append it. */
  const configure = (input: {
    name: string;
    target: ItxExpressionInput | null;
    consumes?: string[];
    afterOffset?: number;
  }) => {
    const event = normalizeControlEvent({
      type: "events.iterate.com/stream/subscription-configured",
      payload: input,
    });
    stream.append(event);
    return event;
  };
  /** Append a raw event as the stream would — a fact the delivery loop appends (`delivery-halted`
   *  has no door on this module). */
  const append = (type: string, payload: Record<string, unknown>): StreamEvent =>
    (stream.append({ type, payload }) as StreamEvent[])[0];
  return { events, rows, configure, append };
};

describe("configure — ONE event: set, replace, or remove", () => {
  test("builds ONE subscription-configured with the target STORED AS THE PARSED FORM; appended, the row's identity is that event's offset", () => {
    const { configure, events, rows } = setup();
    const event = configure({
      name: "tally",
      target: ["itx", "facets", ["get", "tally"], "processEventBatch"],
      consumes: ["mark", "tick"],
    });
    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: "tally",
        target: ["itx", "facets", ["get", "tally"], "processEventBatch"], // the parsed form at rest — a target may carry a whole source as data
        consumes: ["mark", "tick"],
      },
    });
    expect(events).toHaveLength(1);
    expect(rows().tally.configuredAtOffset).toBe(events[0].offset);
  });

  test("omits `consumes` from the payload when none was given", () => {
    const { configure } = setup();
    expect(configure({ name: "all", target: "itx.digest.processEventBatch" }).payload).toEqual({
      name: "all",
      target: ["itx", "digest", "processEventBatch"], // a string target is parsed ONCE, at the door
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
  ])("`afterOffset` $afterOffset is $becomes", ({ afterOffset, payloadHas }) => {
    const { configure, rows } = setup();
    const event = configure({ name: "h", target: "itx.digest.processEventBatch", afterOffset });
    expect(event.payload).toEqual({
      name: "h",
      target: ["itx", "digest", "processEventBatch"],
      ...payloadHas,
    });
    expect(rows().h).toEqual({
      target: ["itx", "digest", "processEventBatch"],
      configuredAtOffset: rows().h.configuredAtOffset,
      ...payloadHas,
    });
  });

  test.each([-1, 1.5, Number.NaN, "0"])(
    "an `afterOffset` that is not a non-negative integer (%s) is refused at the door — a throw, nothing appended",
    (afterOffset) => {
      const { configure, events } = setup();
      expect(() =>
        configure({ name: "h", target: "itx.digest.f", afterOffset: afterOffset as number }),
      ).toThrow(/afterOffset is a non-negative integer/);
      expect(events).toHaveLength(0);
    },
  );

  test("the SAME NAME REPLACES the row — target and filter of the newest configure, never a stack", () => {
    const { configure, events, rows } = setup();
    configure({ name: "w", target: "itx.a.processEventBatch", consumes: ["x"] });
    configure({ name: "w", target: "itx.b.processEventBatch" });
    expect(events).toHaveLength(2);
    expect(Object.keys(rows())).toEqual(["w"]);
    expect(print(rows().w.target)).toBe("itx.b.processEventBatch");
    expect(rows().w).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
    expect(rows().w.configuredAtOffset).toBe(events[1].offset);
  });

  test("a HALTED row re-configured identically gets a fresh row that carries no halt", () => {
    const { configure, append, rows } = setup();
    configure({ name: "digest", target: "itx.digest.processEventBatch" });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 1,
      attempts: 15,
    });
    expect(rows().digest.halted).toBeDefined();
    configure({ name: "digest", target: "itx.digest.processEventBatch" });
    expect(rows().digest).not.toHaveProperty("halted");
  });

  test("a NULL target is the removal: the same event, target null (and no consumes); an unknown name is a no-op through the reduce", () => {
    const { configure, events, rows } = setup();
    configure({ name: "tab", target: "itx.rpcStubs.get('subscription:tab')" });
    expect(configure({ name: "tab", target: null, consumes: ["ignored"] })).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name: "tab", target: null },
    });
    expect(rows()).toEqual({});
    configure({ name: "never-there", target: null });
    expect(events).toHaveLength(3);
    expect(rows()).toEqual({});
  });

  test("the target must be rooted at `itx` (a bare built-in root is unspellable) — a throw, nothing appended", () => {
    const { configure, events } = setup();
    expect(() => configure({ name: "evil", target: "kv.get('a')" })).toThrow(
      /must be rooted at "itx"/,
    );
    expect(() => configure({ name: "evil", target: ["kv", ["get", "a"]] })).toThrow(
      /must be rooted at "itx"/,
    );
    expect(events).toHaveLength(0);
  });

  test("a name is ONE segment, [A-Za-z0-9_-]+, never a key of Object.prototype — a dotted, spaced, `__proto__` or `constructor` name is refused at the door, nothing appended", () => {
    const { configure, events } = setup();
    expect(() => configure({ name: "a.b", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => configure({ name: "has space", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => configure({ name: "a.b", target: null })).toThrow(/one segment/);
    // a key of Object.prototype would name the table's prototype, never a row
    expect(() => configure({ name: "__proto__", target: "itx.whoami" })).toThrow(
      /Object.prototype/,
    );
    expect(() => configure({ name: "constructor", target: "itx.whoami" })).toThrow(
      /Object.prototype/,
    );
    expect(events).toHaveLength(0);
  });

  test("the stored target IS the parsed form: an array target is stored as given (shape-checked, never printed) and the row reduces to it — so the reserved literal `{ '@': true }` is DATA here (the markers belong to a rule's target only)", () => {
    const { configure, rows } = setup();
    const targets: ItxExpression[] = [
      ["itx", "facets", ["get", { "a b": 1e21 }], "processEventBatch"],
      ["itx", "x", ["y", { "@": true }]],
    ];
    for (const [i, target] of targets.entries()) {
      const event = configure({ name: `odd${i}`, target });
      expect((event.payload as { target: unknown }).target).toEqual(target);
      expect(rows()[`odd${i}`].target).toEqual(target);
    }
  });
});
