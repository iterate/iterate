// fix-regressions.failing.test.ts — the bug hunt's SECOND-ORDER pass: attack the recent fixes
// (git since bc6aee3cf) for holes they OPENED. Owned exclusively by the fix-regression agent.
//
// Lane: unit (in-process). Every block asserts CORRECT behaviour. A `test.fails` here is a
// VERIFIED (by running) new/latent defect in code a fix touched — each carries BUG/EXPECTED/
// ACTUAL/WHY. A plain `test` is a regression guard proving a fix holds.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { canonicalName, DurableObjectNameCodec } from "./core/durable-object-names.ts";
import { defineProcessorContract, type StreamEvent, type StreamEventInput } from "./core/events.ts";
import {
  consumesEvent,
  LIVE_STATE_CHANGED,
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorStorage,
  type ProcessorStream,
  type ReduceArgs,
} from "./core/processor.ts";

// ── a FAITHFUL in-memory stream, mirroring the DO's NEW head-clamp read semantics ──
// (the short-page proof is the HEAD — highestAssignedOffset — never `Math.max(after, head)`.)
function memoryStream(path = "/") {
  const durable: StreamEvent[] = [];
  const byKey = new Map<string, StreamEvent>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procs: StreamProcessor<any>[] = [];
  let maxAssigned = 0;
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committed = inputs.map((input) => {
        if (input.idempotencyKey) {
          const hit = byKey.get(input.idempotencyKey);
          if (hit) return hit;
        }
        maxAssigned += 1;
        const event = {
          ...input,
          offset: maxAssigned,
          createdAt: new Date(0).toISOString(),
          path,
        } as StreamEvent;
        if (!input.ephemeral) {
          durable.push(event);
          if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        }
        return event;
      });
      if (maxAssigned > scannedAfterOffset) {
        const range = { after: scannedAfterOffset, through: maxAssigned };
        for (const p of procs) void p.processEventBatch(committed, range).catch(() => {});
      }
      return committed;
    },
    read: (afterOffset = 0, limit = 500) => {
      const page = durable.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        // NEW DO semantics: short page proves the scan reached the HEAD, never beyond.
        scannedThroughOffset: page.length === limit ? page[page.length - 1].offset : maxAssigned,
      });
    },
  };
  return {
    stream,
    procs,
    get head() {
      return maxAssigned;
    },
  };
}

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    storage: {
      get: <T>(k: string) => map.get(k) as T | undefined,
      put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
      delete: (k: string) => void map.delete(k),
    } satisfies ProcessorStorage,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Charset gate at DurableObjectNameCodec.parse (Phase 0 / defect 38, U1). Idea (1): does it
// reject a LEGITIMATE projectId used anywhere, or throw on an internal name it didn't before?
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("charset gate — legitimate names survive, only breach chars are rejected", () => {
  test("every projectId shape the codebase actually uses parses cleanly", () => {
    for (const id of ["prj_demo", "prj_x", "me", "prj_fd_lsbad", "prj_am-forge", "PRJ_UP", "a1"]) {
      expect(() => canonicalName(id)).not.toThrow();
      expect(DurableObjectNameCodec.parse(id).projectId).toBe(id);
    }
  });
  test("a full context name (projectId + dotted .iterate path) still parses; path is unpoliced", () => {
    const n = "prj_demo.iterate/agents/support-bot";
    expect(canonicalName(n)).toBe(n);
    expect(DurableObjectNameCodec.parse(n).projectId).toBe("prj_demo");
    // The wave2 cross-project test relies on a ':' surviving in a PATH segment (kv prefix is the
    // projectId only) — the gate must NOT reject it.
    const withColonPath = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" });
    expect(() => DurableObjectNameCodec.parse(withColonPath)).not.toThrow();
  });
  test("a ':' (or other breach char) in the projectId is rejected loudly", () => {
    expect(() => canonicalName("prj_x:evil")).toThrow(/only \[A-Za-z0-9_-\]/);
    expect(() => canonicalName("prj/x")).toThrow(/only \[A-Za-z0-9_-\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// consumesEvent — the ONE unified rule (Phase B: retires the "*" black hole, 2 divergent copies)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("consumesEvent unified rule (Phase B / defects 10+11)", () => {
  test('"*" delivers every durable event but NEVER sweeps ephemerals', () => {
    expect(consumesEvent(["*"], { type: "a" })).toBe(true);
    expect(consumesEvent(["*"], { type: "b" })).toBe(true);
    expect(consumesEvent(["*"], { type: "eph", ephemeral: true })).toBe(false);
  });
  test("undefined consumes = every durable event, no ephemerals (subscriber default)", () => {
    expect(consumesEvent(undefined, { type: "a" })).toBe(true);
    expect(consumesEvent(undefined, { type: "eph", ephemeral: true })).toBe(false);
  });
  test("a NAMED type opts that type in, INCLUDING when ephemeral", () => {
    expect(consumesEvent(["eph"], { type: "eph", ephemeral: true })).toBe(true);
    expect(consumesEvent(["eph"], { type: "other", ephemeral: true })).toBe(false);
    expect(consumesEvent(["a"], { type: "a" })).toBe(true);
    expect(consumesEvent(["a"], { type: "b" })).toBe(false);
  });
  test("LIVE_STATE_CHANGED is never consumable, even when explicitly named or under *", () => {
    expect(consumesEvent(undefined, { type: LIVE_STATE_CHANGED, ephemeral: true })).toBe(false);
    expect(consumesEvent(["*"], { type: LIVE_STATE_CHANGED, ephemeral: true })).toBe(false);
    expect(consumesEvent([LIVE_STATE_CHANGED], { type: LIVE_STATE_CHANGED, ephemeral: true })).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The runner — #loadProgress no-cache-fallback + refold-to-cursor (Phase C / defects 17, 18)
// ─────────────────────────────────────────────────────────────────────────────────────────────

// A processor that BOTH reduces (state changes) AND records effects (processEvent side effects).
const CountContract = (version: string) =>
  defineProcessorContract({
    slug: "count",
    version,
    description: "counts ticks, records an effect per consumed event",
    stateSchema: z.object({ ticks: z.number().default(0) }),
    events: {},
    consumes: ["tick"],
    emits: [],
  });

class CountProcessor extends StreamProcessor<{ ticks: number }> {
  readonly contract: ReturnType<typeof CountContract>;
  readonly effects: number[] = []; // offsets whose processEvent fired
  constructor(args: ConstructorParameters<typeof StreamProcessor>[0], version = "1.0.0") {
    super(args);
    this.contract = CountContract(version);
  }
  protected override reduce({ event, state }: ReduceArgs<{ ticks: number }>) {
    return event.type === "tick" ? { ticks: state.ticks + 1 } : undefined;
  }
  protected override processEvent(args: ProcessEventArgs<{ ticks: number }>): undefined {
    if (args.event) this.effects.push(args.event.offset);
  }
}

describe("version-bump refold (Phase C)", () => {
  test("refold is reduce-ONLY: a version bump re-folds state without replaying effects", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 5; i++) mem.stream.append({ type: "tick" });
    await p1.wake();
    expect((await p1.snapshot()).state).toEqual({ ticks: 5 });
    expect(p1.effects).toEqual([1, 2, 3, 4, 5]);

    // Fresh incarnation, NEW contract version, SAME storage + log (eviction + redeploy).
    const mem2 = { ...mem };
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem2.procs.length = 0;
    mem.procs.length = 0;
    mem.procs.push(p2);
    const snap = await p2.snapshot(); // triggers wake → refold
    expect(snap.state).toEqual({ ticks: 5 }); // state re-folded correctly
    expect(snap.offset).toBe(5);
    // THE POINT of defect 17's fix: no side effects replay on a version refold.
    expect(p2.effects).toEqual([]);
  });

  test("refold ceiling is the stored cursor: an in-flight push after a bump runs WITH effects (defect 18)", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 3; i++) mem.stream.append({ type: "tick" });
    await p1.wake();
    expect(p1.effects).toEqual([1, 2, 3]);

    // New version instance, then a brand-new push arrives (offset 4). The refold must rebuild
    // 1..3 reduce-only, and event 4 must still run its effect through the normal drive.
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem.procs.length = 0;
    mem.procs.push(p2);
    mem.stream.append({ type: "tick" }); // offset 4, fire-and-forget push
    await settle();
    const snap = await p2.snapshot();
    expect(snap.state).toEqual({ ticks: 4 });
    expect(p2.effects).toEqual([4]); // ONLY the new event replayed effects, not 1..3
  });

  test("version bump with stored cursor 0 terminates and yields initial state", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    // Persist a v1 cursor at offset 0 with a state (as if nothing was ever consumed).
    storage.put("reduce:count:progress", { reducerVersion: "1.0.0", reducedThroughOffset: 0 });
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem.procs.push(p2);
    const snap = await p2.snapshot();
    expect(snap).toEqual({ offset: 0, state: { ticks: 0 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// #loadProgress missing-state fallback — EFFECT-ONLY processor replays effects on eviction.
// The condition `(state !== undefined || cursor.reducedThroughOffset === 0)` drops the persisted
// cursor whenever a processor never wrote state (reduce always keeps initial). Same version, so
// #rereduceIfVersionChanged does NOT fire → progress falls back to 0 → catch-up re-runs effects.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EffectOnlyContract = defineProcessorContract({
  slug: "eff",
  version: "1.0.0",
  description: "pure side-effect processor: reduce never changes state",
  stateSchema: z.object({}),
  events: {},
  consumes: ["*"],
  emits: [],
});
class EffectOnlyProcessor extends StreamProcessor<Record<string, never>> {
  readonly contract = EffectOnlyContract;
  readonly effects: number[] = [];
  protected override reduce(): undefined {
    return undefined; // never changes state — the state key is therefore never persisted
  }
  protected override processEvent(args: ProcessEventArgs<Record<string, never>>): undefined {
    if (args.event) this.effects.push(args.event.offset);
  }
}

describe("effect-only processor eviction (untouched-state loadProgress fallback)", () => {
  // BUG: an effect-only processor (reduce never changes state) REPLAYS EVERY side effect on
  //   every eviction — including the facet quiesce that aborts idle facets every ~60s.
  // EXPECTED: a caught-up processor whose durable cursor is persisted re-does nothing on reload.
  // ACTUAL: p2.effects === [1,2,3,4] — the whole log's effects fire again (verified by running).
  // WHY: #loadProgress accepts the persisted cursor only when `state !== undefined ||
  //   reducedThroughOffset === 0`. A processor that never changed state never writes the state
  //   key, so on reload state === undefined && cursor > 0 → the cursor is DROPPED and progress
  //   falls back to offset 0. Same contract version, so #rereduceIfVersionChanged does NOT fire
  //   (that's the branch Phase C's defect-17 fix protects — it heals the version-BUMP case by
  //   always writing state during the refold, but leaves the same-version case exposed). The
  //   catch-up then re-drives offsets 1..N WITH effects. Phase C ("no side-effect replay
  //   regardless of which verb touches first") closed the version-mismatch door in this exact
  //   function and left the missing-state door open beside it.
  // FIX: accept the persisted cursor whenever the version matches, materializing initialState()
  //   when the state key is absent — i.e. drop `state !== undefined` from the acceptance guard
  //   (or persist state unconditionally on the first durable batch, like the refold already
  //   does). ~1 line in #loadProgress.
  test("FIXED (defect 50): a caught-up effect-only processor does NOT replay effects across an eviction", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p1 = new EffectOnlyProcessor({
      stream: mem.stream,
      storage,
      path: "/",
      projectId: "prj_t",
    });
    mem.procs.push(p1);
    for (let i = 0; i < 4; i++) mem.stream.append({ type: "boop" });
    await p1.wake();
    expect(p1.effects).toEqual([1, 2, 3, 4]);
    // The cursor IS persisted (rule 4), even though state never changed.
    expect(storage.get("reduce:eff:progress")).toMatchObject({ reducedThroughOffset: 4 });

    // Eviction: fresh instance, SAME storage + log, SAME version.
    const p2 = new EffectOnlyProcessor({
      stream: mem.stream,
      storage,
      path: "/",
      projectId: "prj_t",
    });
    mem.procs.length = 0;
    mem.procs.push(p2);
    await p2.wake();
    // CORRECT: the persisted cursor (4) means nothing to re-do.
    expect(p2.effects).toEqual([]);
  });

  test("CONTROL: a state-CHANGING processor does not replay effects across an eviction", async () => {
    // The same eviction, but this processor writes state — so the persisted cursor is honored and
    // no effect re-fires. Proves the bug above is specific to the never-wrote-state case.
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 4; i++) mem.stream.append({ type: "tick" });
    await p1.wake();
    expect(p1.effects).toEqual([1, 2, 3, 4]);

    const p2 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.length = 0;
    mem.procs.push(p2);
    await p2.wake();
    expect(p2.effects).toEqual([]); // cursor honored — no replay
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// waitUntilProcessed — the post-wake .then resolve (Phase C / defect 36 + the refold interplay)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("waitUntilProcessed post-wake resolve", () => {
  test("resolves a waiter whose offset the version refold reached (no #processBatch fired)", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 3; i++) mem.stream.append({ type: "tick" });
    await p1.wake();

    // Fresh version instance; wait for an offset the refold (ceiling = 3) covers. No new push, so
    // the wake's catch-up reads an empty page and never calls #processBatch — only the refold
    // advances progress. The .then re-check must still resolve the waiter.
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem.procs.length = 0;
    mem.procs.push(p2);
    await expect(p2.waitUntilProcessed({ offset: 3, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect(p2.effects).toEqual([]); // still no effect replay
  });

  test("does not spuriously resolve a waiter whose offset was NOT reached", async () => {
    const mem = memoryStream();
    const { storage } = memoryStorage();
    const p = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }); // only offset 1 exists
    await p.wake();
    await expect(p.waitUntilProcessed({ offset: 5, timeoutMs: 120 })).rejects.toThrow(
      /did not reach offset 5/,
    );
  });
});
