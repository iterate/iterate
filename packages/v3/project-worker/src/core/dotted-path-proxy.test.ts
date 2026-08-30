// core/dotted-path-proxy.test.ts — the pure mechanism, in-process (unit lane), driven over a real
// capnweb RpcStub. PORTED (not verbatim) from apps/os/src/domains/itx/path-proxy.test.ts. The
// end-to-end dotted surface over the real worker lives in __tests__/failing-dotted-surface.test.ts.

import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  createInvokeCapabilityPathProxy,
  installPrototypeInvokeCapabilityFallback,
} from "./dotted-path-proxy.ts";

type DynamicCall = { args: unknown[]; path: string[] };

class HostTarget extends RpcTarget {
  calls: DynamicCall[] = [];
  ownField = "private";

  get nested() {
    return {
      math: {
        add(left: number, right: number) {
          return left + right;
        },
      },
    };
  }

  known(value: string) {
    return `known:${value}`;
  }

  invokeCapability(call: DynamicCall) {
    this.calls.push(call);
    return `dynamic:${call.path.join(".")}:${call.args.join(",")}`;
  }
}
installPrototypeInvokeCapabilityFallback(HostTarget);

type HostStub = {
  known(value: string): Promise<string>;
  nested: { math: { add(left: number, right: number): Promise<number> } };
  ownField(): Promise<unknown>;
  tools: { greeter: { sayHello(name: string): Promise<string> } };
};

describe("prototype-chain dynamic fallback", () => {
  it("keeps real RpcTarget members and falls back only for unknown paths", async () => {
    const target = new HostTarget();
    const stub = new RpcStub(target as never) as unknown as HostStub;

    await expect(stub.known("x")).resolves.toBe("known:x");
    await expect(stub.nested.math.add(20, 22)).resolves.toBe(42);
    await expect(stub.tools.greeter.sayHello("Ada")).resolves.toBe(
      "dynamic:tools.greeter.sayHello:Ada",
    );

    expect(target.calls).toEqual([{ args: ["Ada"], path: ["tools", "greeter", "sayHello"] }]);
  });

  it("instances are genuine, unproxied RpcTargets (the whole point: workerd pipelining)", () => {
    // The fallback lives on the PROTOTYPE CHAIN, so the instance stays a plain, natively-branded
    // RpcTarget (no own dynamic props, no instance Proxy) — what workerd's pipeline classifier
    // requires. The live guard for pipelining itself is the harness lane; this pins the structural
    // half the unit lane can see.
    const target = new HostTarget();
    expect(target).toBeInstanceOf(RpcTarget);
    expect(Object.getOwnPropertyNames(target)).toEqual(["calls", "ownField"]);
  });

  it("dispatches through the invoker derived from the RECEIVING instance", () => {
    const a = new HostTarget();
    const b = new HostTarget();
    (a as unknown as { toolA(): unknown }).toolA();
    (b as unknown as { toolB(): unknown }).toolB();
    expect(a.calls).toEqual([{ args: [], path: ["toolA"] }]);
    expect(b.calls).toEqual([{ args: [], path: ["toolB"] }]);
  });

  it("awaiting an instance must not treat it as a thenable", async () => {
    const target = new HostTarget();
    expect((target as unknown as { then: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(target)).resolves.toBe(target);
  });

  it("does not expose RpcTarget instance fields as dynamic paths", async () => {
    const stub = new RpcStub(new HostTarget() as never) as unknown as HostStub;
    await expect(stub.ownField()).rejects.toThrow(/instance property/);
  });

  it("lets __describe traverse dynamic paths over RPC (the host intercepts it)", async () => {
    const target = new HostTarget();
    const stub = new RpcStub(target as never) as unknown as {
      someMount: { sub: { __describe(): Promise<string> } };
    };
    await expect(stub.someMount.sub.__describe()).resolves.toBe(
      "dynamic:someMount.sub.__describe:",
    );
    expect(target.calls).toEqual([{ args: [], path: ["someMount", "sub", "__describe"] }]);
  });

  it("throws on a second install — silent no-op would discard the new options", () => {
    class Once extends RpcTarget {
      calls: DynamicCall[] = [];
      invokeCapability(call: DynamicCall) {
        this.calls.push(call);
        return "ok";
      }
    }
    installPrototypeInvokeCapabilityFallback(Once);
    const hopAfterFirst = Object.getPrototypeOf(Once.prototype) as object;
    expect(() => installPrototypeInvokeCapabilityFallback(Once)).toThrow(
      /already has a fallback hop/,
    );
    expect(Object.getPrototypeOf(Once.prototype)).toBe(hopAfterFirst);

    const target = new Once();
    (target as unknown as { tool(): unknown }).tool();
    expect(target.calls).toEqual([{ args: [], path: ["tool"] }]);
  });

  it("JSON.stringify and test-framework probes must not fire capability dispatches", () => {
    const target = new HostTarget();
    expect(JSON.stringify(target)).toBe(JSON.stringify({ calls: [], ownField: "private" }));
    expect((target as unknown as { toJSON: unknown }).toJSON).toBeUndefined();
    expect((target as unknown as { asymmetricMatch: unknown }).asymmetricMatch).toBeUndefined();
    expect(target.calls).toEqual([]);

    // `inspect` stays dispatchable at BOTH levels (mounted capabilities legitimately expose it).
    expect((target as unknown as { inspect(v: string): unknown }).inspect("surface")).toBe(
      "dynamic:inspect:surface",
    );
    const probe = target as unknown as { agentProbe: { inspect(v: string): unknown } };
    expect(probe.agentProbe.inspect("deep")).toBe("dynamic:agentProbe.inspect:deep");
    expect(target.calls).toEqual([
      { args: ["surface"], path: ["inspect"] },
      { args: ["deep"], path: ["agentProbe", "inspect"] },
    ]);
  });

  it("probes are blocked at DEPTH too — stringify of a path proxy must not dispatch", () => {
    const target = new HostTarget();
    const mount = (target as unknown as Record<string, unknown>).someMount as Record<
      string,
      unknown
    >;
    expect(JSON.stringify({ mount })).toBe("{}");
    expect(mount.toJSON).toBeUndefined();
    expect(mount.asymmetricMatch).toBeUndefined();
    expect("asymmetricMatch" in (mount as object)).toBe(false);
    const deeper = (mount as { sub: Record<string, unknown> }).sub;
    expect(deeper.toJSON).toBeUndefined();
    expect(target.calls).toEqual([]);
  });

  it("resolves the invoker at CALL time, not lookup time (mid-construction safety)", () => {
    const recorded: DynamicCall[] = [];
    class LateHost extends RpcTarget {
      ready = false;
      constructor() {
        super();
        // Probe a dynamic member DURING construction (before `ready` is set): the trap must not
        // bake a dispatcher over half-initialized state — the receiver's invokeCapability resolves
        // only when the path proxy is CALLED, by which point construction has finished.
        void (this as unknown as { probedDuringConstruction: unknown }).probedDuringConstruction;
        this.ready = true;
      }
      invokeCapability(call: DynamicCall) {
        if (!this.ready) throw new Error("invoker resolved before construction finished");
        recorded.push(call);
        return "late";
      }
    }
    installPrototypeInvokeCapabilityFallback(LateHost);

    const instance = new LateHost();
    const early = (instance as unknown as { earlyTool(): unknown }).earlyTool;
    expect(early()).toBe("late");
    expect(recorded).toEqual([{ args: [], path: ["earlyTool"] }]);
  });

  it("does not conjure dispatchers for non-instance receivers (prototype probes)", () => {
    const probed = (HostTarget.prototype as unknown as { someTool: unknown }).someTool;
    expect(probed).toBeUndefined();
  });

  it("subclass instances inherit the fallback and dispatch to themselves", () => {
    class Sub extends HostTarget {
      subKnown() {
        return "sub";
      }
    }
    const sub = new Sub();
    expect(sub.subKnown()).toBe("sub");
    expect(sub.known("y")).toBe("known:y");
    (sub as unknown as { subTool(v: string): unknown }).subTool("z");
    expect(sub.calls).toEqual([{ args: ["z"], path: ["subTool"] }]);
  });

  it("hides reserved path segments from function-backed path proxies", () => {
    const proxy = createInvokeCapabilityPathProxy({ invokeCapability: () => "unreachable" }) as {
      alpha: { then: unknown };
      then: unknown;
    };
    expect(proxy.then).toBeUndefined();
    expect(proxy.alpha.then).toBeUndefined();
  });
});
