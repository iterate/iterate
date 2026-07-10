import util from "node:util";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  createInvokeCapabilityPathProxy,
  installPrototypeInvokeCapabilityFallback,
} from "./utils.ts";

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
  nested: {
    math: {
      add(left: number, right: number): Promise<number>;
    };
  };
  ownField(): Promise<unknown>;
  tools: {
    greeter: {
      sayHello(name: string): Promise<string>;
    };
  };
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
    // workerd's pipeline classifier brand-checks a method call's RESULT and a
    // Proxy never passes (cloudflare/workerd#6873) — the fallback must
    // therefore live on the prototype chain, leaving instances plain. The
    // live guard for the pipelining behavior itself is
    // e2e/vitest/agent-handle-pipelining.itx.e2e.test.ts; this pins the
    // structural half vitest can see.
    const target = new HostTarget();
    expect(util.types.isProxy(target)).toBe(false);
    expect(target).toBeInstanceOf(RpcTarget);
    expect(Object.getOwnPropertyNames(target)).toEqual(["calls", "ownField"]);
  });

  it("dispatches through the invoker derived from the RECEIVING instance", () => {
    // Two instances share one hop (it lives on the class prototype); the
    // trap must route each call to the instance the lookup happened on.
    const a = new HostTarget();
    const b = new HostTarget();
    (a as unknown as { toolA(): unknown }).toolA();
    (b as unknown as { toolB(): unknown }).toolB();
    expect(a.calls).toEqual([{ args: [], path: ["toolA"] }]);
    expect(b.calls).toEqual([{ args: [], path: ["toolB"] }]);
  });

  it("supports a custom invokerFor (surfaces that dispatch through their capability host)", () => {
    const recorded: DynamicCall[] = [];
    class Handle extends RpcTarget {
      get host() {
        return {
          invokeCapability(call: DynamicCall) {
            recorded.push(call);
            return `via-host:${call.path.join(".")}`;
          },
        };
      }
    }
    installPrototypeInvokeCapabilityFallback(Handle, {
      invokerFor: (handle) => handle.host,
    });

    const result = (new Handle() as unknown as { someTool(n: number): unknown }).someTool(7);
    expect(result).toBe("via-host:someTool");
    expect(recorded).toEqual([{ args: [7], path: ["someTool"] }]);
  });

  it("awaiting an instance must not treat it as a thenable", async () => {
    // `then` reaching the dynamic fallback would turn every `await stub` into
    // a capability call that never resolves.
    const target = new HostTarget();
    expect((target as unknown as { then: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(target)).resolves.toBe(target);
  });

  it("does not expose RpcTarget instance fields as dynamic paths", async () => {
    const stub = new RpcStub(new HostTarget() as never) as unknown as HostStub;

    await expect(stub.ownField()).rejects.toThrow(/instance property/);
  });

  it("lets __describe traverse dynamic paths over RPC (the host intercepts it)", async () => {
    // NOT reserved on purpose: the capability-host processor answers trailing
    // __describe from mount metadata, so the fallback must let it through.
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
    // JSON.stringify LOOKS UP toJSON and CALLS it if callable; vitest/jest
    // equality probes asymmetricMatch; chai/loupe probes inspect. Each of
    // those reaching the dynamic fallback would turn a stringify/assert/log
    // into a live invokeCapability call (observed: a floating rejection from
    // stringifying a handle). Blocked at the HOP only — deeper path segments
    // named e.g. `inspect` stay valid capability methods (see
    // PROTOCOL_PROBE_KEYS in utils.ts).
    const target = new HostTarget();
    expect(JSON.stringify(target)).toBe(JSON.stringify({ calls: [], ownField: "private" }));
    expect((target as unknown as { toJSON: unknown }).toJSON).toBeUndefined();
    expect((target as unknown as { asymmetricMatch: unknown }).asymmetricMatch).toBeUndefined();
    expect((target as unknown as { inspect: unknown }).inspect).toBeUndefined();
    expect(target.calls).toEqual([]);

    // ...but at DEPTH the same names are ordinary capability methods.
    const probe = target as unknown as { agentProbe: { inspect(v: string): unknown } };
    expect(probe.agentProbe.inspect("deep")).toBe("dynamic:agentProbe.inspect:deep");
    expect(target.calls).toEqual([{ args: ["deep"], path: ["agentProbe", "inspect"] }]);
  });

  it("resolves the invoker at CALL time, not lookup time (mid-construction safety)", () => {
    // A property miss on `this` during a base-class constructor fires the
    // trap before field initializers ran. The dispatcher it hands back must
    // not bake in that half-initialized state.
    const recorded: DynamicCall[] = [];
    class LateHost extends RpcTarget {
      host: { invokeCapability(call: DynamicCall): unknown } | undefined;

      constructor() {
        super();
        // Simulates a feature-detect miss during construction: the trap runs
        // while `host` is still undefined.
        void (this as unknown as { probedDuringConstruction: unknown }).probedDuringConstruction;
        this.host = {
          invokeCapability(call: DynamicCall) {
            recorded.push(call);
            return "late";
          },
        };
      }
    }
    installPrototypeInvokeCapabilityFallback(LateHost, {
      invokerFor: (instance) => {
        const host = (instance as LateHost).host;
        if (host === undefined) throw new Error("invoker resolved before construction finished");
        return host;
      },
    });

    const instance = new LateHost();
    // The dispatcher grabbed during construction still works, because the
    // invoker resolves now — after construction — not when the trap fired.
    const early = (instance as unknown as { earlyTool(): unknown }).earlyTool;
    expect(early()).toBe("late");
    expect(recorded).toEqual([{ args: [], path: ["earlyTool"] }]);
  });

  it("does not conjure dispatchers for non-instance receivers (prototype probes)", () => {
    // Frameworks and debugging tools read properties off prototypes directly;
    // the fallback must answer plain undefined there — invokerFor would
    // otherwise run against a receiver with no instance state.
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
    const proxy = createInvokeCapabilityPathProxy({
      invokeCapability: () => "unreachable",
    }) as {
      alpha: {
        then: unknown;
      };
      then: unknown;
    };

    expect(proxy.then).toBeUndefined();
    expect(proxy.alpha.then).toBeUndefined();
  });
});

type DynamicCall = {
  args: unknown[];
  path: string[];
};
