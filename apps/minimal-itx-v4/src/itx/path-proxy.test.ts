import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import { createInvokeCapabilityPathProxy, withInvokeCapabilityFallback } from "./path-proxy.ts";

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

describe("dynamic path proxy", () => {
  it("keeps real RpcTarget members and falls back only for unknown paths", async () => {
    const target = new HostTarget();
    const host = withInvokeCapabilityFallback(target);
    const stub = new RpcStub(host as never) as unknown as HostStub;

    await expect(stub.known("x")).resolves.toBe("known:x");
    await expect(stub.nested.math.add(20, 22)).resolves.toBe(42);
    await expect(stub.tools.greeter.sayHello("Ada")).resolves.toBe(
      "dynamic:tools.greeter.sayHello:Ada",
    );

    expect(target.calls).toEqual([{ args: ["Ada"], path: ["tools", "greeter", "sayHello"] }]);
  });

  it("wraps ordinary objects that implement invokeCapability", () => {
    const target = withInvokeCapabilityFallback({
      calls: [] as DynamicCall[],
      invokeCapability(call: DynamicCall) {
        this.calls.push(call);
        return call.path.join(".");
      },
      ping(value: string) {
        return `pong:${value}`;
      },
    }) as unknown as PlainTarget;

    expect(target.ping("x")).toBe("pong:x");
    expect(target.tools.greeter.sayHello("Ada")).toBe("tools.greeter.sayHello");
    expect(target.calls).toEqual([{ args: ["Ada"], path: ["tools", "greeter", "sayHello"] }]);
  });

  it("does not expose RpcTarget instance fields as dynamic paths", async () => {
    const host = withInvokeCapabilityFallback(new HostTarget());
    const stub = new RpcStub(host as never) as unknown as HostStub;

    await expect(stub.ownField()).rejects.toThrow(/instance property/);
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

type PlainTarget = {
  calls: DynamicCall[];
  ping(value: string): string;
  tools: {
    greeter: {
      sayHello(name: string): string;
    };
  };
};
