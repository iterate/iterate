// The capability table's executable spec — shadow stack, provenance gate, default-deny,
// recursion, string-at-rest payloads, delivery + processor policies riding the mount event.
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

/** A tiny fake built-ins record — enough physical layer to route into. */
const fakeBuiltIns = () => {
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
        ["itx.clients", "clients"],
        ["itx.openai", "openai"],
      ],
      ...extraConfigMounts,
    ].map(([path, target]) => ({ path: parseCapabilityPath(path), target: parse(target) })),
  });
  // INLINE HOSTING, exactly like the parent: reduce the durable log per call.
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

describe("config mounts (config provenance)", () => {
  test("built-ins route through their config mounts", async () => {
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

  test("a provided capability may NOT name a built-in (provenance gate at provide time)", async () => {
    const { host } = setup();
    await expect(host.provide({ path: "itx.evil", target: "kv" })).rejects.toThrow(
      /must be rooted at "itx"/,
    );
  });

  test("even a smuggled raw event cannot reach the built-ins (gate is scope-absence)", async () => {
    const { stream, invoke } = setup();
    // bypass provide() entirely — append the raw string-at-rest event, as a hostile writer would
    stream.append({
      type: "events.iterate.com/capability-table/capability-provided",
      payload: { path: "itx.evil", target: "kv" },
    });
    await expect(invoke("itx.evil.get('a')")).rejects.toThrow(/"kv" is not in scope/);
  });

  test("a malformed payload is skipped loudly, never wedging later resolves", async () => {
    const { stream, invoke } = setup();
    stream.append({
      type: "events.iterate.com/capability-table/capability-provided",
      payload: { path: "itx.broken(", target: "itx.kv" },
    });
    // the table still answers — the bad mount simply doesn't exist
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });
});

describe("event mounts + the shadow stack", () => {
  test("⚠️ a self-referential mount errors at depth, never spins", async () => {
    const { host, invoke } = setup();
    await host.provide({ path: "itx.loop", target: "itx.loop" });
    await expect(invoke("itx.loop.go()")).rejects.toThrow(/depth 32/);
  });

  test("alias mount: remainder replays through the recursive itx scope", async () => {
    const { host, invoke } = setup();
    await host.provide({ path: "itx.db", target: "itx.kv" });
    await invoke("itx.db.put('k', 'v')");
    expect(await invoke("itx.kv.get('k')")).toBe("v"); // same underlying kv — alias composed
  });

  test("STRING AT REST: the mount event stores the string halves verbatim", async () => {
    const { host, events } = setup();
    await host.provide({ path: "itx.db", target: ["itx", "clients", ["get", "tab-1"]] });
    const payload = events.at(-1)!.payload as { path: string; target: string };
    expect(payload.path).toBe("itx.db"); // human-readable in the log
    expect(payload.target).toBe("itx.clients.get('tab-1')"); // print-canonicalized
  });

  test("shadowing: newest same-path mount wins; revoke-by-offset restores what's beneath", async () => {
    const { host, invoke, builtIns } = setup();
    builtIns._connect("tab-1", { hello: () => "from tab-1" });
    builtIns._connect("tab-2", { hello: () => "from tab-2" });
    const first = await host.provide({ path: "itx.greeter", target: "itx.clients.get('tab-1')" });
    const second = await host.provide({ path: "itx.greeter", target: "itx.clients.get('tab-2')" });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // newest wins
    await host.revoke({ providedAtOffset: second.providedAtOffset });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored, not lost
    await host.revoke({ providedAtOffset: first.providedAtOffset });
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no capability matches/);
  });

  test("boundary args: a call at the mount itself applies the evaluated target", async () => {
    const { host, invoke, builtIns } = setup();
    await host.provide({ path: "itx.grok", target: "itx.openai.chat" });
    expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
    expect(builtIns.openaiCalls[0]).toEqual({ model: "grok-4" });
  });

  test("default route: bare `itx` forwards whole missed calls (ancestry with zero machinery)", async () => {
    const { host, invoke, builtIns } = setup();
    const osCalls: string[] = [];
    builtIns._connect("platform", {
      anything: (...a: unknown[]) => (osCalls.push(`anything(${a.join(",")})`), "handled upstream"),
    });
    await host.provide({ path: "itx", target: "itx.clients.get('platform')" });
    expect(await invoke("itx.anything('x')")).toBe("handled upstream");
    expect(osCalls).toEqual(["anything(x)"]);
    // config mounts still win over the default route for what they claim (more specific)
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("inherited built-ins are unreachable through the table (probe-resistance end to end)", async () => {
    const { invoke } = setup();
    await expect(invoke("itx.kv.toString()")).rejects.toThrow(/is not a method/);
  });

  test("bare CALL on the scope symbol is a loud error even as a hand-crafted Expression", async () => {
    const { host } = setup();
    await expect(host.resolveCurrent([["itx", 1]] as unknown as Expression)).rejects.toThrow(
      /cannot call the scope symbol itself/,
    );
  });

  test("live-capability desugar shape: provide = park + mount into clients", async () => {
    const { host, invoke, builtIns } = setup();
    builtIns._connect("conn-42", { move: (n: unknown) => `moved ${n}` });
    const provision = await host.provide({
      path: "itx.robot",
      target: "itx.clients.get('conn-42')",
    });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    // socket death = the registry entry vanishes → calls fail; revoke pops the mount
    builtIns._disconnect("conn-42");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    await host.revoke({ providedAtOffset: provision.providedAtOffset });
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no capability matches/);
  });

  test("delivery + processor policies ride the mount event and land in the reduced table", async () => {
    const { host, reduceAll } = setup();
    await host.provide({
      path: "itx.subscribers.watcher",
      target: "itx.clients.get('conn-1')",
      delivery: { consumes: ["mark"], liveState: undefined },
    });
    await host.provide({
      path: "itx.processors.tally",
      target: "itx.facets.get('tally')",
      processor: { props: { greeting: "hi" } },
    });
    const table = reduceAll();
    const sub = table.mounts.find((m) => m.path.join(".") === "itx.subscribers.watcher")!;
    const proc = table.mounts.find((m) => m.path.join(".") === "itx.processors.tally")!;
    expect(sub.delivery).toEqual({ consumes: ["mark"] });
    expect(proc.processor).toEqual({ props: { greeting: "hi" } });
  });
});
