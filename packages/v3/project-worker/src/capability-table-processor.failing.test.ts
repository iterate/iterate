// BUG-HUNT SPEC for the capability table (reduce / provide / revoke / resolve / route / shadow
// stack / provenance). Every test asserts CORRECT behavior. `test.fails(...)` marks a case
// VERIFIED failing today (each body opens with BUG/EXPECTED/ACTUAL/WHY IT MATTERS). Plain
// `test(...)` cases already pass and document correct behavior. No production code is touched.
// Helpers are copied (not imported) from capability-table-processor.test.ts per the brief.
import { describe, expect, test } from "vitest";
import { parse, parseCapabilityPath, type Expression } from "./core/expression.ts";
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

const throwOffline = (key: string): never => {
  throw new Error(`client "${key}" is offline`);
};

/** A tiny fake built-ins record — enough physical layer to route into. */
const fakeBuiltIns = () => {
  const kv = new Map<string, string>();
  const connections = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
  const openaiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: unknown) => kv.get(String(k)) ?? null,
      put: (k: string, v: string) => (kv.set(k, v), { ok: true }),
    },
    connections: { get: (key: string) => connections.get(key) ?? throwOffline(key) },
    whoami: () => ({ projectId: "prj_t", path: "/" }),
    openai: { chat: (o: { model: string }) => (openaiCalls.push(o), `chat:${o.model}`) },
    openaiCalls,
    _connect: (key: string, cap: Record<string, (...a: unknown[]) => unknown>) =>
      connections.set(key, cap),
    _disconnect: (key: string) => connections.delete(key),
  };
};

const setup = (extraConfigMounts: [string, string][] = []) => {
  const { stream, events } = memoryStream();
  const builtIns = fakeBuiltIns();
  const host = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    configMounts: [
      ...[
        ["itx.whoami", "whoami"],
        ["itx.kv", "kv"],
        ["itx.connections", "connections"],
        ["itx.openai", "openai"],
      ],
      ...extraConfigMounts,
    ].map(([path, target]) => ({ path: parseCapabilityPath(path), target: parse(target) })),
  });
  const reduceAll = () =>
    events.reduce(
      (st, e) => host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  host.resolveCurrent = async (call: Expression, depth = 0) =>
    host.resolve(reduceAll(), call, undefined, depth);
  const invoke = (call: string) => host.resolveCurrent(parse(call));
  return { stream, events, host, builtIns, invoke, reduceAll };
};

// ─────────────── the codec asymmetry surfaces as a SILENTLY DROPPED MOUNT ───────────────

describe("provide → print → reduce → parse: an un-round-trippable target vanishes", () => {
  test.fails("a mount target with a large number literal is silently dropped", async () => {
    // BUG: provide() canonicalizes the target through print(); print renders 1e21 as "1e+21"
    //      (JSON.stringify), which the parser cannot read. reduce() re-parses the stored string,
    //      throws, and CATCHES it as "malformed-mount.skipped" — the mount never enters the table.
    // EXPECTED: a target built from valid Expression data (a number is valid) mounts and routes.
    // ACTUAL: provide() RETURNS a providedAtOffset (the caller believes it succeeded), but every
    //      later resolve default-denies because the stored string `itx.connections.get('c').echo(1e+21)`
    //      fails to re-parse on reduce.
    // WHY IT MATTERS: a provide() that returns success while producing an unroutable table is a
    //      silent authority-loss. The offset handed back is a lie — revoke has nothing to pop and
    //      the capability is simply gone, with only a warn line in the log.
    const { host, invoke, builtIns } = setup();
    builtIns._connect("c", { echo: (n: unknown) => `echo:${n}` });
    const { providedAtOffset } = await host.provide({
      path: "itx.big",
      target: ["itx", "connections", ["get", "c"], ["echo", 1e21]] as Expression,
    });
    expect(providedAtOffset).toBeGreaterThan(0);
    expect(await invoke("itx.big()")).toBe(`echo:${1e21}`); // ← rejects: NO_CAPABILITY_MATCH
  });

  test.fails("a mount target whose object arg has a non-identifier key is silently dropped", async () => {
    // BUG: same print/parse asymmetry via object keys — print emits keys unquoted, so a key with a
    //      space ("a b") produces `{ a b: ... }`, which the parser rejects on reduce.
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
    expect(await invoke("itx.alias()")).toBe("chat:undefined"); // ← rejects: NO_CAPABILITY_MATCH
  });
});

// ─────────────── shadow stack / config fallback / revoke (already correct) ───────────────

describe("shadow stack + revoke", () => {
  test("an event mount shadows a CONFIG mount; revoke restores the config mount", async () => {
    const { host, invoke, builtIns } = setup();
    builtIns._connect("tab-1", { get: (k: unknown) => `conn:${k}` });
    // config already mounts itx.kv ⇒ kv; shadow it with an event mount at the SAME path.
    const prov = await host.provide({ path: "itx.kv", target: "itx.connections.get('tab-1')" });
    expect(await invoke("itx.kv.get('a')")).toBe("conn:a"); // event mount wins over config
    await host.revoke({ providedAtOffset: prov.providedAtOffset });
    // the config kv is restored (not lost) — write then read the real built-in store.
    await invoke("itx.kv.put('a', 'restored')");
    expect(await invoke("itx.kv.get('a')")).toBe("restored");
  });

  test("revoking an offset that was never provided is a silent no-op; the table still resolves", async () => {
    const { host, invoke } = setup();
    await expect(host.revoke({ providedAtOffset: 999 })).resolves.toBeUndefined();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("config mounts are unrevocable — a revoke naming any offset leaves them intact", async () => {
    const { host, invoke } = setup();
    // config mounts carry no providedAtOffset, so no revoke event can ever pop one.
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
      target: "itx.connections.get('conn-1')", // evaluates to a plain object, not a function
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

// ─────────────── speculative / unspecified (not yet a verified bug) ───────────────

describe("open questions", () => {
  // Two CONFIG mounts at the same path: event mounts break ties by offset (newest wins), but
  // config mounts all carry providedAtOffset === undefined, so route() keeps the FIRST considered.
  // Whether "later config overrides earlier" (CSS-like) or "first wins" is the intended rule is
  // unspecified in the code — characterized as first-wins in scratch, but no spec to assert
  // against. Left as a todo rather than a fabricated verdict.
  test.todo("precedence between two same-path CONFIG mounts is unspecified (currently first-wins)");
});
