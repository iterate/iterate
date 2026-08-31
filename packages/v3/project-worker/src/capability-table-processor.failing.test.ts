// BUG-HUNT SPEC for the capability table (reduce / provide / revoke / resolve / route / shadow
// stack / built-ins-first). Every test asserts CORRECT behavior. `test.fails(...)` marks a case
// VERIFIED failing today (each body opens with BUG/EXPECTED/ACTUAL/WHY IT MATTERS). Plain
// `test(...)` cases already pass and document correct behavior. No production code is touched.
// Helpers are copied (not imported) from capability-table-processor.test.ts per the brief.
import { describe, expect, test } from "vitest";
import { parse, type Expression } from "./core/expression.ts";
import { CapabilityTableProcessor } from "./capability-table-processor.ts";
import { type ProcessorStream } from "./core/processor.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";

function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const byKey = new Map<string, StreamEvent>();
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) =>
      inputs.map((input) => {
        if (input.idempotencyKey) {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) {
            if (sameIdempotentEvent(existing, input)) return existing;
            throw new Error(idempotencyConflictMessage(input.idempotencyKey, existing.offset));
          }
        }
        const event: StreamEvent = {
          ...input,
          offset: events.length + 1,
          createdAt: new Date(0).toISOString(),
          path,
        };
        events.push(event);
        if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        return event;
      }),
    read: (afterOffset = 0, limit = 500) => {
      const page = events.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit
            ? page[page.length - 1].offset
            : Math.max(afterOffset, events.length),
      });
    },
  };
  return { stream, events };
}

/** A tiny fake built-ins record — enough physical layer to route into. */
const fakeBuiltIns = () => {
  const kv = new Map<string, string>();
  const connections = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
  const openaiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: unknown) => kv.get(String(k)) ?? null,
      put: (k: string, v: string) => {
        kv.set(k, v);
        return { ok: true };
      },
    },
    rpcStubs: {
      get: (key: string) => {
        const cap = connections.get(key);
        if (cap === undefined) throw new Error(`client "${key}" is offline`);
        return cap;
      },
    },
    whoami: () => ({ projectId: "prj_t", path: "/" }),
    openai: {
      chat: (o: { model: string }) => {
        openaiCalls.push(o);
        return `chat:${o.model}`;
      },
    },
    openaiCalls,
    _connect: (key: string, cap: Record<string, (...a: unknown[]) => unknown>) =>
      connections.set(key, cap),
    _disconnect: (key: string) => connections.delete(key),
  };
};

const setup = () => {
  const { stream, events } = memoryStream();
  const builtIns = fakeBuiltIns();
  // whoami/kv/rpcStubs/openai are KEYS in fakeBuiltIns() → `itx.<root>…` resolves DIRECTLY
  // (built-ins first, unshadowable); no config, no base mounts.
  const reduceAll = () =>
    events.reduce(
      (st, e) => host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  const resolveNow = (call: Expression, depth = 0) =>
    host.resolve(reduceAll(), call, undefined, depth);
  const host: CapabilityTableProcessor = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    resolveCurrent: resolveNow,
  });
  return {
    stream,
    events,
    host,
    builtIns,
    invoke: (call: string) => resolveNow(parse(call)),
    reduceAll,
    resolveNow,
  };
};

// ─────────────── the codec asymmetry surfaces as a SILENTLY DROPPED MOUNT ───────────────

describe("provide → print → reduce → parse: an un-round-trippable target vanishes", () => {
  test("a mount target with a large number literal ROUTES (FIXED defect 1)", async () => {
    // FIXED: print renders 1e21 as "1e+21" (JSON.stringify), which the parser's #number now reads
    //      (exponent branch) — the stored target re-parses on reduce and the mount enters the table.
    // EXPECTED: a target built from valid Expression data (a number is valid) mounts and routes.
    // ACTUAL: provide() RETURNS a providedAtOffset (the caller believes it succeeded), but every
    //      later resolve default-denies because the stored string `itx.rpcStubs.get('c').echo(1e+21)`
    //      fails to re-parse on reduce.
    // WHY IT MATTERS: a provide() that returns success while producing an unroutable table is a
    //      silent authority-loss. The offset handed back is a lie — revoke has nothing to pop and
    //      the capability is simply gone, with only a warn line in the log.
    const { host, invoke, builtIns } = setup();
    builtIns._connect("c", { echo: (n: unknown) => `echo:${n}` });
    const { providedAtOffset } = await host.provide({
      path: "itx.big",
      target: ["itx", "rpcStubs", ["get", "c"], ["echo", 1e21]] as Expression,
    });
    expect(providedAtOffset).toBeGreaterThan(0);
    // Resolve the mount (its target is a complete call) — it ROUTES now instead of vanishing.
    expect(await invoke("itx.big")).toBe(`echo:${1e21}`);
  });

  test("a mount target with a non-identifier object key ROUTES (FIXED defect 3)", async () => {
    // FIXED: print now QUOTES a non-identifier key (a space, dot, leading digit), so `{ 'a b': … }`
    //      re-parses on reduce via #object's quoted-key branch — the mount routes.
    // EXPECTED: a target passing a structured object arg (any string keys) mounts and routes.
    // ACTUAL: provide() succeeds; reduce() skips the malformed re-parse; resolve default-denies.
    // WHY IT MATTERS: mount targets routinely carry structured args; a single exotic key key
    //      silently un-mounts the capability while provide() reports success.
    const { host, invoke } = setup();
    const { providedAtOffset } = await host.provide({
      path: "itx.alias",
      target: ["itx", "openai", ["chat", { "a b": "grok-4" }]] as Expression,
    });
    expect(providedAtOffset).toBeGreaterThan(0);
    // openai.chat reads o.model (absent here) → "chat:undefined"; the point is it ROUTES at all.
    expect(await invoke("itx.alias")).toBe("chat:undefined");
  });
});

// ─────────────── shadow stack / config fallback / revoke (already correct) ───────────────

describe("built-ins-first + revoke", () => {
  test("revoking an offset that was never provided is a silent no-op; the table still resolves", async () => {
    const { host, invoke } = setup();
    await expect(host.revoke({ providedAtOffset: 999 })).resolves.toBeUndefined();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("built-ins are unrevocable — a revoke naming any offset leaves them intact", async () => {
    const { host, invoke } = setup();
    // built-ins carry no providedAtOffset (they are not mounts), so no revoke event can pop one.
    await host.revoke({ providedAtOffset: 1 });
    await host.revoke({ providedAtOffset: 2 });
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.kv.get('a')")).toBe("1");
  });
});

// ─────────────── resolve recursion depth (already correct) ───────────────

describe("resolve depth budget", () => {
  const buildChain = async (host: CapabilityTableProcessor, n: number) => {
    for (let i = 1; i < n; i++) await host.provide({ path: `itx.a${i}`, target: `itx.a${i + 1}` });
    await host.provide({ path: `itx.a${n}`, target: "itx.kv" });
  };

  test("a 32-deep alias chain resolves", async () => {
    const { host, invoke } = setup();
    await buildChain(host, 32);
    await invoke("itx.a1.put('k', 'v')");
    expect(await invoke("itx.a1.get('k')")).toBe("v");
  });

  test("a 33-deep alias chain trips the depth-32 guard (burns nothing)", async () => {
    const { host, invoke } = setup();
    await buildChain(host, 33);
    await expect(invoke("itx.a1.get('k')")).rejects.toThrow(/depth 32/);
  });
});

// ─────────────── deliverTo by row identity (already correct) ───────────────

describe("deliverTo", () => {
  test("applies the delivery args to a METHOD-valued subscription target", async () => {
    const { host, reduceAll } = setup();
    // absent-target lane: the target resolves to a callable (a method on a built-in here).
    const { providedAtOffset } = await host.provide({
      path: "itx.subscribers.watcher",
      target: "itx.openai.chat",
      delivery: { consumes: ["mark"] },
    });
    const result = await host.deliverTo(reduceAll(), providedAtOffset, [{ model: "batch" }]);
    expect(result).toBe("chat:batch");
  });

  test("a non-callable subscription target errors loudly (never a silent drop)", async () => {
    const { host, invoke, reduceAll, builtIns } = setup();
    builtIns._connect("conn-1", { onEvents: () => "ok" });
    const { providedAtOffset } = await host.provide({
      path: "itx.subscribers.plain",
      target: "itx.rpcStubs.get('conn-1')", // evaluates to a plain object, not a function
      delivery: { consumes: ["mark"] },
    });
    void invoke; // (kept for parity with other tests' destructuring)
    await expect(host.deliverTo(reduceAll(), providedAtOffset, [{ batch: 1 }])).rejects.toThrow(
      /not callable/,
    );
  });

  test("deliverTo on an unknown offset is a loud error", async () => {
    const { host, reduceAll } = setup();
    await expect(host.deliverTo(reduceAll(), 424242, [])).rejects.toThrow(/no subscription mount/);
  });
});
