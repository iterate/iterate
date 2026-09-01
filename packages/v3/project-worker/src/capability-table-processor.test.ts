// The capability table's executable spec — shadow stack, built-ins-first, default-deny,
// recursion, string-at-rest payloads (a mount is `{ path, target }` and nothing else), and
// the live-capability shape: a mount is PURE DATA naming the `itx.rpcStubs` built-in (the
// physical registry), so reconnect is zero events and a dead stub leaves its mount offline.
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
  // The fake `itx.rpcStubs` BUILT-IN — the physical registry behind a live provide, keyed by the
  // string the stub was parked under, exactly like the DO's RpcStubDirectory. _connect/_disconnect
  // simulate a pager attach / final close. A mount names an entry through the pure-data target
  // `itx.rpcStubs.get('<key>')`; nothing about the registry is in the log.
  const liveStubs = new Map<string, unknown>();
  const rpcStubs = {
    get: (key: string) =>
      new InvokeHandle((segments, args) => {
        const cap = liveStubs.get(key);
        if (cap === undefined) throw new Error(`live capability "${key}" is offline`);
        if (segments.length === 0) return (cap as (...a: unknown[]) => unknown)(...args);
        let recv = cap as Record<string, unknown>;
        for (const seg of segments.slice(0, -1)) recv = recv[seg] as Record<string, unknown>;
        return (recv[segments.at(-1)!] as (...a: unknown[]) => unknown)(...args);
      }),
    list: () => [...liveStubs.keys()],
  };
  const host: CapabilityTableProcessor = new CapabilityTableProcessor({
    stream,
    builtIns: { ...builtIns, rpcStubs } as unknown as Record<string, unknown>,
    resolveCurrent: resolveNow,
  });
  /** The edge sugar `itx.provide(path, fn)`, spelled out: park under the path, mount the
   *  pure-data target. */
  const provideLive = (path: string, cap: unknown, extra: Record<string, unknown> = {}) => {
    liveStubs.set(path, cap);
    return host.provide({ path, target: `itx.rpcStubs.get('${path}')`, ...extra });
  };
  return {
    stream,
    events,
    host,
    builtIns,
    invoke: (call: string) => resolveNow(parse(call)),
    reduceAll,
    resolveNow,
    provideLive,
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

  test("a LIVE provide is an ordinary mount whose target names the registry — pure data, nothing about the socket", async () => {
    const { events, provideLive } = setup();
    await provideLive("itx.cam", { shot: () => "frame" });
    const payload = events.at(-1)!.payload as Record<string, unknown>;
    expect(payload).toEqual({ path: "itx.cam", target: "itx.rpcStubs.get('itx.cam')" });
  });

  test("the door demands a target rooted at itx (a bare built-in root is unspellable)", async () => {
    const { host } = setup();
    await expect(host.provide({ path: "itx.x", target: "kv" })).rejects.toThrow(/rooted at "itx"/);
  });

  test("shadowing: newest same-path EXPRESSION mount wins; revoke-by-offset restores what's beneath", async () => {
    const { host, invoke, provideLive } = setup();
    await provideLive("itx.tab1", { hello: () => "from tab-1" });
    await provideLive("itx.tab2", { hello: () => "from tab-2" });
    const first = await host.provide({ path: "itx.greeter", target: "itx.tab1" });
    const second = await host.provide({ path: "itx.greeter", target: "itx.tab2" });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // newest wins
    await host.revoke({ providedAtOffset: second.providedAtOffset });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored, not lost
    await host.revoke({ providedAtOffset: first.providedAtOffset });
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no capability matches/);
  });

  test("RECONNECT IS ZERO EVENTS: the mount is data, the stub is physical — re-parking serves the same mount", async () => {
    const { host, invoke, events, reduceAll, provideLive, _connect, _disconnect } = setup();
    const mount = await provideLive("itx.cam", { shot: () => "frame 1" });
    const logLength = events.length;
    // The provider drops and comes back: the registry entry is replaced, the log is untouched.
    _disconnect("itx.cam");
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/offline/);
    _connect("itx.cam", { shot: () => "frame 2" });
    expect(await invoke("itx.cam.shot()")).toBe("frame 2");
    expect(events).toHaveLength(logLength);
    const rows = reduceAll().mounts.filter((m) => m.path.join(".") === "itx.cam");
    expect(rows.map((r) => r.providedAtOffset)).toEqual([mount.providedAtOffset]);
    // Revoking the one mount → default-deny, even though the stub is still parked.
    await host.revoke({ providedAtOffset: mount.providedAtOffset });
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/no capability matches/);
    expect(await invoke("itx.rpcStubs.list()")).toEqual(["itx.cam"]); // presence is physical
  });

  test("a revoked EXPRESSION mount above a live mount restores the live mount beneath", async () => {
    const { host, invoke, provideLive } = setup();
    await provideLive("itx.mixed", { who: () => "the live stub" });
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
    const { invoke, provideLive } = setup();
    const osCalls: string[] = [];
    await provideLive("itx", {
      anything: (...a: unknown[]) => {
        osCalls.push(`anything(${a.join(",")})`);
        return "handled upstream";
      },
    });
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

  test("live-capability shape: mounted-but-offline (forever, until revoked) vs never-provided", async () => {
    const { host, invoke, reduceAll, provideLive, _disconnect } = setup();
    const provision = await provideLive("itx.robot", { move: (n: unknown) => `moved ${n}` });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    // Transport death = the mount still exists but can't serve: CONNECTION_OFFLINE, and it STAYS
    // that way — no auto-revoke ever pops a mount because a socket dropped (the mount is the
    // user's intent; the socket is weather). Revoke pops the mount → default-deny.
    _disconnect("itx.robot");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    expect(reduceAll().mounts.some((m) => m.path.join(".") === "itx.robot")).toBe(true);
    await host.revoke({ providedAtOffset: provision.providedAtOffset });
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no capability matches/);
  });
});
