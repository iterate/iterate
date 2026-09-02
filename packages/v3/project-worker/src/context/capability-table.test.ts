// The capability table's executable spec (src/context/capability-table.ts): the two COMMANDS
// (`capabilityProvidedEvent` / `capabilityRevokedEvent` BUILD the events — validation and the codec
// round-trip fail LOUD at the door, the caller appends), the pure `route`, and `CapabilityResolver`
// (built-ins first + unshadowable, longest path then newest, default-deny, targets resolved through
// the same resolver one level deeper, the depth-32 budget). The mounts THEMSELVES are `core` state: this file reduces
// the durable log through `CoreStreamProcessor` per call, exactly as the DO does (the reduce's own
// pins live in stream/core-processor.test.ts). The live-capability shape rides along: a live provide
// is PURE DATA naming the `itx.rpcStubs` built-in (the physical registry), so reconnect is zero
// events and a dead stub leaves its mount offline.
import { describe, expect, test } from "vitest";
import { CoreStreamProcessor, type Mount } from "../stream/core-processor.ts";
import type { StreamEvent } from "../stream/events.ts";
import { memoryStream } from "../stream/test-support.ts";
import {
  CapabilityResolver,
  capabilityProvidedEvent,
  capabilityRevokedEvent,
  route,
} from "./capability-table.ts";
import { parse, type Expression, type ItxExpression } from "./expression.ts";
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
  const core = new CoreStreamProcessor();
  const builtIns = fakeBuiltIns();
  // No config, no base mounts: whoami/kv/openai are KEYS in fakeBuiltIns(), so `itx.<root>…`
  // resolves DIRECTLY against the physical scope (built-ins first, unshadowable).
  // INLINE HOSTING, exactly like the parent: the mounts are core state, reduced from the durable
  // log per call — and, as in Stream.#reduceEventIntoCoreReducedState, a malformed control event is
  // skipped (reported), never wedging the stream.
  const mounts = (): Mount[] =>
    events.reduce((st, e) => {
      try {
        return core.reduce({ event: e, state: st }) ?? st;
      } catch {
        return st;
      }
    }, core.contract.initialState()).mounts;
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
  const resolver = new CapabilityResolver({ builtIns: { ...builtIns, rpcStubs }, mounts });
  /** The DO's `provideCapability`, minus its idempotency policy: build the event, append it, hand
   *  back the mount's identity. A refusal throws at the door — nothing is appended. */
  const provide = (input: { path: string; target: ItxExpression }) => {
    const [committed] = stream.append(capabilityProvidedEvent(input)) as StreamEvent[];
    return { providedAtOffset: committed.offset };
  };
  /** The edge sugar `itx.provide(path, fn)`, spelled out: park under the path, mount the
   *  pure-data target. */
  const provideLive = (path: string, cap: unknown) => {
    liveStubs.set(path, cap);
    return provide({ path, target: `itx.rpcStubs.get('${path}')` });
  };
  return {
    stream,
    events,
    builtIns,
    mounts,
    invoke: (call: ItxExpression) => resolver.resolve(call),
    provide,
    /** The DO's `revokeCapability` by identity: append the revoked event (idempotent through the reduce). */
    revoke: (providedAtOffset: number) => {
      stream.append(capabilityRevokedEvent(providedAtOffset));
    },
    provideLive,
    _connect: (path: string, cap: unknown) => liveStubs.set(path, cap),
    _disconnect: (path: string) => liveStubs.delete(path),
  };
};

describe("the door — capabilityProvidedEvent / capabilityRevokedEvent build the events, loudly", () => {
  test("STRING AT REST: the provided event stores both halves as strings — the target print-canonicalized, human-readable in the log", () => {
    expect(
      capabilityProvidedEvent({ path: "itx.db", target: ["itx", "facets", ["get", "tab-1"]] }),
    ).toEqual({
      type: "events.iterate.com/capability-table/capability-provided",
      payload: { path: "itx.db", target: "itx.facets.get('tab-1')" },
    });
    // a dotted STRING target is accepted too (either codec half) and lands verbatim once appended
    const { events, provide } = setup();
    provide({ path: "itx.db", target: "itx.facets.get('tab-1')" });
    expect(events.at(-1)!.payload).toEqual({ path: "itx.db", target: "itx.facets.get('tab-1')" });
  });

  test("a provided capability may NOT name a bare built-in (the target must be rooted at itx — a bare root is unspellable)", () => {
    expect(() => capabilityProvidedEvent({ path: "itx.evil", target: "kv" })).toThrow(
      /must be rooted at "itx"/,
    );
    expect(() => capabilityProvidedEvent({ path: "itx.x", target: ["kv", "get"] })).toThrow(
      /must be rooted at "itx"/,
    );
  });

  test("a capability path is dotted names only — a call step or an unbalanced paren is refused at the door", () => {
    expect(() => capabilityProvidedEvent({ path: "itx.a()", target: "itx.kv" })).toThrow(
      /dotted names only/,
    );
    expect(() => capabilityProvidedEvent({ path: "itx.broken(", target: "itx.kv" })).toThrow(
      /unbalanced/,
    );
  });

  test("revoked names the mount's identity; a non-positive offset is refused (no mount was ever at 0)", () => {
    expect(capabilityRevokedEvent(7)).toEqual({
      type: "events.iterate.com/capability-table/capability-revoked",
      payload: { providedAtOffset: 7 },
    });
    expect(() => capabilityRevokedEvent(0)).toThrow();
  });
});

describe("route — pure: longest matching path, then newest; null when nothing matches", () => {
  const mount = (path: string, target: string, providedAtOffset: number): Mount => ({
    path: path.split("."),
    target: parse(target),
    providedAtOffset,
  });

  test("the LONGEST matching path wins, even over a newer shorter one; the steps after the mount are what the path did not consume", () => {
    const table = [mount("itx.a.b", "itx.long", 1), mount("itx.a", "itx.short", 2)];
    const deep = route(table, parse("itx.a.b.f(1)"))!;
    expect(deep.mount.providedAtOffset).toBe(1);
    expect(deep).toMatchObject({ argsAtMount: undefined, stepsAfterMount: [["f", 1]] });
    const shallow = route(table, parse("itx.a.c.f()"))!;
    expect(shallow.mount.providedAtOffset).toBe(2);
    expect(shallow.stepsAfterMount).toEqual(["c", ["f"]]);
  });

  test("same length → the NEWEST mount (highest providedAtOffset), whatever its position in the table", () => {
    const table = [mount("itx.g", "itx.tab2", 5), mount("itx.g", "itx.tab1", 3)];
    expect(route(table, parse("itx.g.hello()"))!.mount.providedAtOffset).toBe(5);
  });

  test("a call AT the mount consumes its args as the args at the mount", () => {
    const hit = route(
      [mount("itx.grok", "itx.openai.chat", 1)],
      parse("itx.grok({ model: 'm' })"),
    )!;
    expect(hit).toMatchObject({ argsAtMount: [{ model: "m" }], stepsAfterMount: [] });
  });

  test("nothing matches → null (the resolver turns this into default-deny)", () => {
    expect(route([mount("itx.a", "itx.kv", 1)], parse("itx.b.f()"))).toBeNull();
    expect(route([], parse("itx.a"))).toBeNull();
  });
});

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

  test("even a smuggled raw event cannot reach the built-ins (a target not rooted at itx matches nothing — default-deny)", async () => {
    const { stream, invoke } = setup();
    // bypass the door entirely — append the raw string-at-rest event, as a hostile writer would
    stream.append({
      type: "events.iterate.com/capability-table/capability-provided",
      payload: { path: "itx.evil", target: "kv" },
    });
    await expect(invoke("itx.evil.get('a')")).rejects.toThrow(/no capability matches "kv"/);
  });

  test("a malformed raw payload is skipped by the reduce, never wedging later resolves", async () => {
    const { stream, invoke } = setup();
    stream.append({
      type: "events.iterate.com/capability-table/capability-provided",
      payload: { path: "itx.broken(", target: "itx.kv" },
    });
    // the table still answers — the bad mount simply doesn't exist
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    await expect(invoke("itx.broken.x()")).rejects.toThrow(/no capability matches/);
  });
});

describe("event mounts + the shadow stack", () => {
  test("⚠️ a self-referential mount errors at depth, never spins", async () => {
    const { provide, invoke } = setup();
    provide({ path: "itx.loop", target: "itx.loop" });
    await expect(invoke("itx.loop.go()")).rejects.toThrow(/depth 32/);
  });

  test("alias mount: the target resolves one level deeper, the steps after the mount replay on it", async () => {
    const { provide, invoke } = setup();
    provide({ path: "itx.db", target: "itx.kv" });
    await invoke("itx.db.put('k', 'v')");
    expect(await invoke("itx.kv.get('k')")).toBe("v"); // same underlying kv — alias composed
  });

  test("a LIVE provide is an ordinary mount whose target names the registry — pure data, nothing about the socket", () => {
    const { events, provideLive } = setup();
    provideLive("itx.cam", { shot: () => "frame" });
    const payload = events.at(-1)!.payload as Record<string, unknown>;
    expect(payload).toEqual({ path: "itx.cam", target: "itx.rpcStubs.get('itx.cam')" });
  });

  test("LONGEST PATH WINS at resolve: a deeper mount takes the calls under it, the shorter keeps the rest", async () => {
    const { provideLive, provide, invoke } = setup();
    provideLive("itx.wide", { f: () => "wide", deep: { f: () => "wide's deep" } });
    provideLive("itx.narrow", { f: () => "narrow" });
    provide({ path: "itx.a", target: "itx.wide" });
    provide({ path: "itx.a.deep", target: "itx.narrow" }); // newer AND longer
    expect(await invoke("itx.a.deep.f()")).toBe("narrow");
    expect(await invoke("itx.a.f()")).toBe("wide");
  });

  test("shadowing: newest same-path EXPRESSION mount wins; revoke-by-offset restores what's beneath", async () => {
    const { provide, revoke, invoke, provideLive } = setup();
    provideLive("itx.tab1", { hello: () => "from tab-1" });
    provideLive("itx.tab2", { hello: () => "from tab-2" });
    const first = provide({ path: "itx.greeter", target: "itx.tab1" });
    const second = provide({ path: "itx.greeter", target: "itx.tab2" });
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // newest wins
    revoke(second.providedAtOffset);
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored, not lost
    revoke(first.providedAtOffset);
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no capability matches/);
  });

  test("RECONNECT IS ZERO EVENTS: the mount is data, the stub is physical — re-parking serves the same mount", async () => {
    const { revoke, invoke, events, mounts, provideLive, _connect, _disconnect } = setup();
    const mount = provideLive("itx.cam", { shot: () => "frame 1" });
    const logLength = events.length;
    // The provider drops and comes back: the registry entry is replaced, the log is untouched.
    _disconnect("itx.cam");
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/offline/);
    _connect("itx.cam", { shot: () => "frame 2" });
    expect(await invoke("itx.cam.shot()")).toBe("frame 2");
    expect(events).toHaveLength(logLength);
    const rows = mounts().filter((m) => m.path.join(".") === "itx.cam");
    expect(rows.map((r) => r.providedAtOffset)).toEqual([mount.providedAtOffset]);
    // Revoking the one mount → default-deny, even though the stub is still parked.
    revoke(mount.providedAtOffset);
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/no capability matches/);
    expect(await invoke("itx.rpcStubs.list()")).toEqual(["itx.cam"]); // presence is physical
  });

  test("a revoked EXPRESSION mount above a live mount restores the live mount beneath", async () => {
    const { provide, revoke, invoke, provideLive } = setup();
    provideLive("itx.mixed", { who: () => "the live stub" });
    const alias = provide({ path: "itx.mixed", target: "itx.whoami" });
    expect(await invoke("itx.mixed()")).toEqual({ projectId: "prj_t", path: "/" }); // expr shadows
    revoke(alias.providedAtOffset);
    expect(await invoke("itx.mixed.who()")).toBe("the live stub"); // live row restored
  });

  test("args at the mount: a call at the mount itself applies the resolved target", async () => {
    const { provide, invoke, builtIns } = setup();
    provide({ path: "itx.grok", target: "itx.openai.chat" });
    expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
    expect(builtIns.openaiCalls[0]).toEqual({ model: "grok-4" });
  });

  test("default route: a LIVE stub at bare `itx` catches whole missed calls (ancestry with zero machinery)", async () => {
    const { invoke, provideLive } = setup();
    const osCalls: string[] = [];
    provideLive("itx", {
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
    const { invoke } = setup();
    await expect(invoke([["itx", 1]] as unknown as Expression)).rejects.toThrow(
      /cannot call the scope symbol itself/,
    );
  });

  test("live-capability shape: mounted-but-offline (forever, until revoked) vs never-provided", async () => {
    const { revoke, invoke, mounts, provideLive, _disconnect } = setup();
    const provision = provideLive("itx.robot", { move: (n: unknown) => `moved ${n}` });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    // Transport death = the mount still exists but can't serve: offline, and it STAYS that way —
    // no auto-revoke ever pops a mount because a socket dropped (the mount is the user's intent;
    // the socket is weather). Revoke pops the mount → default-deny.
    _disconnect("itx.robot");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    expect(mounts().some((m) => m.path.join(".") === "itx.robot")).toBe(true);
    revoke(provision.providedAtOffset);
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no capability matches/);
  });
});

describe("targets round-trip the codec: provide → print → reduce → parse", () => {
  // A door that returned success while its stored string failed to re-parse would leave a silently
  // unroutable table — the offset handed back a lie, revoke with nothing to pop.
  test("a mount target with a large number literal routes (print renders 1e21 as 1e+21; the parser reads the exponent)", async () => {
    const { provide, invoke, provideLive } = setup();
    provideLive("itx.c", { echo: (n: unknown) => `echo:${n}` });
    const { providedAtOffset } = provide({
      path: "itx.big",
      target: ["itx", "c", ["echo", 1e21]] as Expression,
    });
    expect(providedAtOffset).toBeGreaterThan(0);
    expect(await invoke("itx.big")).toBe(`echo:${1e21}`); // the target is a complete call
  });

  test("a mount target with a non-identifier object key routes (print QUOTES the key; the parser re-reads it)", async () => {
    const { provide, invoke } = setup();
    const { providedAtOffset } = provide({
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
    const { revoke, invoke } = setup();
    expect(() => revoke(999)).not.toThrow();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("built-ins are unrevocable — a revoke naming any offset leaves them intact", async () => {
    const { revoke, invoke } = setup();
    // built-ins carry no providedAtOffset (they are not mounts), so no revoke event can pop one.
    revoke(1);
    revoke(2);
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.kv.get('a')")).toBe("1");
  });
});

describe("resolve depth budget", () => {
  const buildChain = (provide: ReturnType<typeof setup>["provide"], n: number) => {
    for (let i = 1; i < n; i++) provide({ path: `itx.a${i}`, target: `itx.a${i + 1}` });
    provide({ path: `itx.a${n}`, target: "itx.kv" });
  };

  test("a 32-deep alias chain resolves", async () => {
    const { provide, invoke } = setup();
    buildChain(provide, 32);
    await invoke("itx.a1.put('k', 'v')");
    expect(await invoke("itx.a1.get('k')")).toBe("v");
  });

  test("a 33-deep alias chain trips the depth-32 guard (burns nothing)", async () => {
    const { provide, invoke } = setup();
    buildChain(provide, 33);
    await expect(invoke("itx.a1.get('k')")).rejects.toThrow(/depth 32/);
  });
});
