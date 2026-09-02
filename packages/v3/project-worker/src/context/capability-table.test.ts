// The capability table's executable spec — shadow stack, built-ins-first, default-deny,
// recursion (the depth-32 budget), string-at-rest payloads (a mount is `{ path, target }` and
// nothing else; a target is PRINTED to a string at rest and re-parsed on reduce, so it must
// round-trip the codec), and the live-capability shape: a mount is PURE DATA naming the
// `itx.rpcStubs` built-in (the physical registry), so reconnect is zero events and a dead stub
// leaves its mount offline.
import { describe, expect, test } from "vitest";
import { memoryStream } from "../stream/test-support.ts";
import { parse, type Expression } from "./expression.ts";
import { CapabilityTableProcessor } from "./capability-table.ts";
import { InvokeHandle } from "./invoke-handle.ts";

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

describe("targets round-trip the codec: provide → print → reduce → parse", () => {
  // A provide() that returned success while its stored string failed to re-parse would leave a
  // silently unroutable table — the offset handed back a lie, revoke with nothing to pop.
  test("a mount target with a large number literal routes (print renders 1e21 as 1e+21; the parser reads the exponent)", async () => {
    const { host, invoke, provideLive } = setup();
    await provideLive("itx.c", { echo: (n: unknown) => `echo:${n}` });
    const { providedAtOffset } = await host.provide({
      path: "itx.big",
      target: ["itx", "c", ["echo", 1e21]] as Expression,
    });
    expect(providedAtOffset).toBeGreaterThan(0);
    expect(await invoke("itx.big")).toBe(`echo:${1e21}`); // the target is a complete call
  });

  test("a mount target with a non-identifier object key routes (print QUOTES the key; the parser re-reads it)", async () => {
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

describe("revoke against nothing", () => {
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
