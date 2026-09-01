// The capability table's executable spec — shadow stack, built-ins-first, default-deny,
// recursion, string-at-rest payloads, delivery + processor policies riding the mount event.
import { describe, expect, test } from "vitest";
import { parse, type Expression } from "./core/expression.ts";
import { CapabilityTableProcessor } from "./capability-table-processor.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
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
  const openaiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: string) => kv.get(k) ?? null,
      put: (k: string, v: string) => {
        kv.set(k, v);
        return { ok: true };
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
  };
};

const setup = () => {
  const { stream, events } = memoryStream();
  const builtIns = fakeBuiltIns();
  // No config, no base mounts: whoami/kv/openai are KEYS in fakeBuiltIns(), so `itx.<root>…`
  // resolves DIRECTLY against the physical scope (built-ins first, unshadowable).
  // INLINE HOSTING, exactly like the parent: reduce the durable log per call.
  const reduceAll = () =>
    events.reduce(
      (st, e) => host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  const resolveNow = (call: Expression, depth = 0) =>
    host.resolve(reduceAll(), call, undefined, depth);
  // The fake TRANSPORT TABLE behind the injected liveStub bridge — keyed by mount path, exactly
  // like the DO's RpcStubDirectory. _connect/_disconnect simulate a pager attach / final close.
  const liveStubs = new Map<string, unknown>();
  const host: CapabilityTableProcessor = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    resolveCurrent: resolveNow,
    liveStub: (pathString) =>
      new InvokeHandle((segments, args) => {
        const cap = liveStubs.get(pathString);
        if (cap === undefined) throw new Error(`live capability "${pathString}" is offline`);
        if (segments.length === 0) return (cap as (...a: unknown[]) => unknown)(...args);
        let recv = cap as Record<string, unknown>;
        for (const seg of segments.slice(0, -1)) recv = recv[seg] as Record<string, unknown>;
        return (recv[segments.at(-1)!] as (...a: unknown[]) => unknown)(...args);
      }),
  });
  return {
    stream,
    events,
    host,
    builtIns,
    invoke: (call: string) => resolveNow(parse(call)),
    reduceAll,
    resolveNow,
    _connect: (path: string, cap: unknown) => liveStubs.set(path, cap),
    _disconnect: (path: string) => liveStubs.delete(path),
  };
};

describe("built-in resolution + default-deny", () => {
  test("built-ins resolve directly (no mount, no config)", async () => {
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

  test("a provided capability may NOT name a bare built-in (target must be rooted at itx)", async () => {
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
    await host.provide({ path: "itx.db", target: ["itx", "facets", ["get", "tab-1"]] });
    const payload = events.at(-1)!.payload as { path: string; target: string };
    expect(payload.path).toBe("itx.db"); // human-readable in the log
    expect(payload.target).toBe("itx.facets.get('tab-1')"); // print-canonicalized
  });

  test("a LIVE provide stores `live: true` and NO target (the flag is the truth)", async () => {
    const { host, events } = setup();
    await host.provide({ path: "itx.cam", live: true });
    const payload = events.at(-1)!.payload as { path: string; target?: string; live?: true };
    expect(payload).toEqual({ path: "itx.cam", live: true }); // no durable target exists
  });

  test("the door demands exactly one of target/live", async () => {
    const { host } = setup();
    await expect(host.provide({ path: "itx.x" })).rejects.toThrow(/exactly one of/);
    await expect(host.provide({ path: "itx.x", target: "itx.kv", live: true })).rejects.toThrow(
      /exactly one of/,
    );
  });

  test("shadowing: newest same-path EXPRESSION mount wins; revoke-by-offset restores what's beneath", async () => {
    const { host, invoke, _connect } = setup();
    _connect("itx.tab1", { hello: () => "from tab-1" });
    _connect("itx.tab2", { hello: () => "from tab-2" });
    await host.provide({ path: "itx.tab1", live: true });
    await host.provide({ path: "itx.tab2", live: true });
    const first = await host.provide({ path: "itx.greeter", target: "itx.tab1" });
    const second = await host.provide({ path: "itx.greeter", target: "itx.tab2" });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // newest wins
    await host.revoke({ providedAtOffset: second.providedAtOffset });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored, not lost
    await host.revoke({ providedAtOffset: first.providedAtOffset });
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no capability matches/);
  });

  test("ONE live row per path: a live re-provide SUPERSEDES in place — no shadow, no restore", async () => {
    const { host, invoke, reduceAll, _connect } = setup();
    _connect("itx.cam", { shot: () => "frame" });
    await host.provide({ path: "itx.cam", live: true });
    const second = await host.provide({ path: "itx.cam", live: true }); // the reconnect record
    const rows = reduceAll().mounts.filter((m) => m.path.join(".") === "itx.cam");
    expect(rows).toHaveLength(1); // superseded in place — the table stays bounded across reconnects
    expect(rows[0].providedAtOffset).toBe(second.providedAtOffset);
    expect(await invoke("itx.cam.shot()")).toBe("frame");
    // Revoking THE live row leaves nothing live beneath (it is necessarily the last).
    await host.revoke({ providedAtOffset: second.providedAtOffset });
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/no capability matches/);
  });

  test("a revoked EXPRESSION mount above a live row restores the live row beneath", async () => {
    const { host, invoke, _connect } = setup();
    _connect("itx.mixed", { who: () => "the live stub" });
    await host.provide({ path: "itx.mixed", live: true });
    const alias = await host.provide({ path: "itx.mixed", target: "itx.whoami" });
    expect(await invoke("itx.mixed()")).toEqual({ projectId: "prj_t", path: "/" }); // expr shadows
    await host.revoke({ providedAtOffset: alias.providedAtOffset });
    expect(await invoke("itx.mixed.who()")).toBe("the live stub"); // live row restored
  });

  test("boundary args: a call at the mount itself applies the evaluated target", async () => {
    const { host, invoke, builtIns } = setup();
    await host.provide({ path: "itx.grok", target: "itx.openai.chat" });
    expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
    expect(builtIns.openaiCalls[0]).toEqual({ model: "grok-4" });
  });

  test("default route: a LIVE stub at bare `itx` catches whole missed calls (ancestry with zero machinery)", async () => {
    const { host, invoke, _connect } = setup();
    const osCalls: string[] = [];
    _connect("itx", {
      anything: (...a: unknown[]) => {
        osCalls.push(`anything(${a.join(",")})`);
        return "handled upstream";
      },
    });
    await host.provide({ path: "itx", live: true });
    expect(await invoke("itx.anything('x')")).toBe("handled upstream");
    expect(osCalls).toEqual(["anything(x)"]);
    // built-ins still resolve BEFORE the default route (built-in-first, unshadowable)
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("inherited built-ins are unreachable through the table (probe-resistance end to end)", async () => {
    const { invoke } = setup();
    await expect(invoke("itx.kv.toString()")).rejects.toThrow(/is not a method/);
  });

  test("bare CALL on the scope symbol is a loud error even as a hand-crafted Expression", async () => {
    const { resolveNow } = setup();
    await expect(resolveNow([["itx", 1]] as unknown as Expression)).rejects.toThrow(
      /cannot call the scope symbol itself/,
    );
  });

  test("live-capability shape: the mount path IS the stub — mounted-but-offline vs never-provided", async () => {
    const { host, invoke, _connect, _disconnect } = setup();
    _connect("itx.robot", { move: (n: unknown) => `moved ${n}` });
    const provision = await host.provide({ path: "itx.robot", live: true });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    // transport death = the row still exists but can't serve (CONNECTION_OFFLINE territory);
    // revoke pops the row → default-deny (NO_CAPABILITY_MATCH — never-provided semantics)
    _disconnect("itx.robot");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    await host.revoke({ providedAtOffset: provision.providedAtOffset });
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no capability matches/);
  });

  test("delivery + processor policies ride the mount event and land in the reduced table", async () => {
    const { host, reduceAll } = setup();
    await host.provide({
      path: "itx.subscribers.watcher",
      live: true,
      delivery: { consumes: ["mark"], liveState: undefined },
    });
    await host.provide({
      path: "itx.subscribers.tally",
      target: "itx.facets.get('tally')",
      processor: { className: "Tally" },
    });
    const table = reduceAll();
    const sub = table.mounts.find((m) => m.path.join(".") === "itx.subscribers.watcher")!;
    const proc = table.mounts.find((m) => m.path.join(".") === "itx.subscribers.tally")!;
    expect(sub.delivery).toEqual({ consumes: ["mark"] });
    expect(proc.processor).toEqual({ className: "Tally" });
  });
});
