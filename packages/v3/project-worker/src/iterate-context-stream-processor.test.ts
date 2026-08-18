// The routing table's executable spec — shadow stack, provenance gate, default-deny, recursion.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parse, type Expression } from "./core/expression.ts";
import { IterateContextStreamProcessor } from "./iterate-context-stream-processor.ts";
import { createStreamProcessorRegistry, type ProcessorStream } from "./core/processor.ts";
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
    read: (afterOffset = 0, limit = 500) =>
      events.filter((e) => e.offset > afterOffset).slice(0, limit),
  };
  return { stream, events };
}

const memoryStorage = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
  };
};

/** A tiny fake `roots` — enough physical layer to route into. */
const fakeRoots = () => {
  const kv = new Map<string, string>();
  const clients = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
  const openaiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: string) => kv.get(k) ?? null,
      put: (k: string, v: string) => (kv.set(k, v), { ok: true }),
    },
    clients: { get: (key: string) => clients.get(key) ?? throwOffline(key) },
    whoami: () => ({ projectId: "prj_t", path: "/" }),
    openai: { chat: (o: { model: string }) => (openaiCalls.push(o), `chat:${o.model}`) },
    openaiCalls,
    _connect: (key: string, cap: Record<string, (...a: unknown[]) => unknown>) =>
      clients.set(key, cap),
    _disconnect: (key: string) => clients.delete(key),
  };
};
const throwOffline = (key: string): never => {
  throw new Error(`client "${key}" is offline`);
};

const setup = (seeds: [string, string][] = []) => {
  const { stream, events } = memoryStream();
  const storage = memoryStorage();
  const roots = fakeRoots();
  const registry = createStreamProcessorRegistry({
    storage,
    stream,
    path: "/",
    projectId: "prj_t",
  });
  const host = registry.register(
    new IterateContextStreamProcessor({
      stream,
      path: "/",
      projectId: "prj_t",
      roots,
      seeds: [
        ...[
          ["itx.whoami", "roots.whoami"],
          ["itx.kv", "roots.kv"],
          ["itx.clients", "roots.clients"],
        ],
        ...seeds,
      ].map(([pattern, target]) => ({ pattern: parse(pattern), target: parse(target) })),
    }),
  );
  const reads = registry.reads(host);
  // wire the recursion: `itx.…` inside a target re-enters resolve with the freshly folded state
  host.resolveCurrent = async (call: Expression, depth = 0) => {
    await registry.catchUp("iterate-context");
    return host.resolve((await reads.snapshot()).state, call, undefined, depth);
  };
  const invoke = (call: string) => host.resolveCurrent(parse(call));
  return { stream, events, registry, host, reads, roots, invoke };
};

describe("seeds (config provenance)", () => {
  test("built-ins route into roots", async () => {
    const { invoke } = setup();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.kv.get('a')")).toBe("1");
  });

  test("default-deny: no match is a readable error", async () => {
    const { invoke } = setup();
    await expect(invoke("itx.nope.thing()")).rejects.toThrow(
      /no capability matches.*itx\.nope\.thing/,
    );
  });

  test("a provided capability may NOT reference roots (provenance gate at provide time)", async () => {
    const { host } = setup();
    await expect(host.provide({ pattern: "itx.evil", target: "roots.kv" })).rejects.toThrow(
      /config seeds only/,
    );
  });

  test("even a smuggled event mount cannot reach roots (gate is scope-absence, not validation)", async () => {
    const { stream, invoke, registry } = setup();
    // bypass provide() entirely — append the raw event, as a hostile writer would
    stream.append({
      type: "events.iterate.com/capability-host/capability-provided",
      payload: { pattern: ["itx", "evil"], target: ["roots", "kv"] },
    });
    await registry.catchUp();
    await expect(invoke("itx.evil.get('a')")).rejects.toThrow(/"roots" is not in scope/);
  });
});

describe("event mounts + the shadow stack", () => {
  test("⚠️ a self-referential mount errors at depth, never spins", async () => {
    const { host, invoke } = setup();
    await host.provide({ pattern: "itx.loop", target: "itx.loop" });
    await expect(invoke("itx.loop.go()")).rejects.toThrow(/depth 32/);
  });

  test("alias mount: remainder replays through the recursive itx scope", async () => {
    const { host, invoke } = setup();
    await host.provide({ pattern: "itx.db", target: "itx.kv" });
    await invoke("itx.db.put('k', 'v')");
    expect(await invoke("itx.kv.get('k')")).toBe("v"); // same underlying kv — alias composed
  });

  test("shadowing: newest same-pattern mount wins; revoke-by-offset restores what's beneath", async () => {
    const { host, invoke, roots } = setup();
    roots._connect("tab-1", { hello: () => "from tab-1" });
    roots._connect("tab-2", { hello: () => "from tab-2" });
    const first = await host.provide({
      pattern: "itx.greeter",
      target: "itx.clients.get('tab-1')",
    });
    const second = await host.provide({
      pattern: "itx.greeter",
      target: "itx.clients.get('tab-2')",
    });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // newest wins
    await host.revoke({ providedAtOffset: second.providedAtOffset });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored, not lost
    await host.revoke({ providedAtOffset: first.providedAtOffset });
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no capability matches/);
  });

  test("specificity: a literal-arg mount beats the bare seed for exactly that key", async () => {
    const { host, invoke, roots } = setup();
    roots._connect("basement-pc", { read: (n: unknown) => `remote read ${n}` });
    await host.provide({
      pattern: "itx.kv.get('big-noisy-one')",
      target: "itx.clients.get('basement-pc').read('big-noisy-one')",
    });
    await invoke("itx.kv.put('big-noisy-one', 'local')");
    await invoke("itx.kv.put('other', 'local-other')");
    expect(await invoke("itx.kv.get('big-noisy-one')")).toBe("remote read big-noisy-one"); // re-homed
    expect(await invoke("itx.kv.get('other')")).toBe("local-other"); // everything else untouched
  });

  test("frozen args + spread-merge: frozen wins", async () => {
    const { host, invoke, roots } = setup([["itx.openai", "roots.openai"]]);
    await host.provide({
      pattern: "itx.grok",
      target: "itx.openai.chat({ model: 'grok-4', ...? })",
    });
    expect(await invoke("itx.grok({ model: 'evil', temperature: 1 })")).toBe("chat:grok-4");
    expect(roots.openaiCalls[0]).toEqual({ model: "grok-4", temperature: 1 });
  });

  test("captures flow from pattern to target", async () => {
    const { host, invoke, roots } = setup();
    roots._connect("agent-blah", { ask: (q: unknown) => `blah answers ${q}` });
    await host.provide({ pattern: "itx.agents.get(?name)", target: "itx.clients.get(?name)" });
    expect(await invoke("itx.agents.get('agent-blah').ask('hi')")).toBe("blah answers hi");
  });

  test("must-use rule: a pattern capture the target ignores is a provide-time error", async () => {
    const { host } = setup();
    await expect(host.provide({ pattern: "itx.f(?x)", target: "itx.kv" })).rejects.toThrow(
      /must-use/,
    );
  });

  test("$-escaped data that merely LOOKS like a capture is inert to the must-use rule", async () => {
    const { host } = setup();
    // pattern arg is the LITERAL {"?": "x"}, not a binding — provide must not demand a use of ?x
    await expect(
      host.provide({ pattern: ["itx", ["f", { $: { "?": "x" } }]], target: ["itx", "kv"] }),
    ).resolves.toEqual({ providedAtOffset: expect.any(Number) });
  });

  test("default route: bare `itx` forwards whole missed calls (ancestry with zero machinery)", async () => {
    const { host, invoke, roots } = setup();
    const osCalls: string[] = [];
    roots._connect("platform", {
      anything: (...a: unknown[]) => (osCalls.push(`anything(${a.join(",")})`), "handled upstream"),
    });
    await host.provide({ pattern: "itx", target: "itx.clients.get('platform')" });
    expect(await invoke("itx.anything('x')")).toBe("handled upstream");
    expect(osCalls).toEqual(["anything(x)"]);
    // seeds still win over the default route for what they claim (more specific)
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("bare CALL on the scope symbol is a loud error even as a hand-crafted Expression", async () => {
    const { host } = setup();
    // the string half can no longer spell this (parse rejects `itx(1)`); close the structured door too
    await expect(host.resolveCurrent([["itx", 1]])).rejects.toThrow(
      /cannot call the scope symbol itself/,
    );
  });

  test("live-capability desugar shape: provide = park + alias into clients", async () => {
    const { host, invoke, roots } = setup();
    // the edge parks the stub under a connection key, then provides the alias:
    roots._connect("conn-42", { move: (n: unknown) => `moved ${n}` });
    const provision = await host.provide({
      pattern: "itx.robot",
      target: "itx.clients.get('conn-42')",
    });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    // socket death = the registry entry vanishes → calls fail; revoke pops the mount
    roots._disconnect("conn-42");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    await host.revoke({ providedAtOffset: provision.providedAtOffset });
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no capability matches/);
  });
});
