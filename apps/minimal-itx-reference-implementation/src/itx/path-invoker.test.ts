import { describe, expect, it } from "vitest";
import { objectToPathInvoker, pathInvokerToProxy } from "./path-invoker.ts";

class HostBase {
  hidden() {
    return "base";
  }
}

class Host extends HostBase {
  calls: Array<{ path: string[]; args?: unknown[] }> = [];

  ping(value: string) {
    return `pong:${value}`;
  }

  get nested() {
    return {
      math: {
        add(a: number, b: number) {
          return a + b;
        },
      },
    };
  }

  invokeCapability(input: { path: string[]; args?: unknown[] }) {
    this.calls.push(input);
    return `invoked:${input.path.join(".")}:${input.args?.join(",") ?? ""}`;
  }
}

describe("path invoker adapters", () => {
  it("turns a dotted proxy call into one invokeCapability call", async () => {
    const calls: Array<{ path: string[]; args?: unknown[] }> = [];
    const proxy = pathInvokerToProxy({
      invokeCapability(input) {
        calls.push(input);
        return "ok";
      },
    });

    expect(proxy.slack.chat.postMessage({ text: "hi" })).toBe("ok");
    expect(calls).toEqual([{ path: ["slack", "chat", "postMessage"], args: [{ text: "hi" }] }]);
  });

  it("turns an object surface into a path invoker", async () => {
    const host = new Host();
    const invoker = objectToPathInvoker(host, HostBase.prototype);

    await expect(invoker.invokeCapability({ path: ["ping"], args: ["x"] })).resolves.toBe("pong:x");
    await expect(
      invoker.invokeCapability({ path: ["nested", "math", "add"], args: [2, 3] }),
    ).resolves.toBe(5);
  });

  it("only exposes members below the explicit stop prototype", async () => {
    const host = new Host();
    const invoker = objectToPathInvoker(host, HostBase.prototype);

    await expect(invoker.invokeCapability({ path: ["hidden"], args: [] })).rejects.toThrow(
      'no host capability "hidden"',
    );
  });

  it("round-trips object -> invoker -> proxy", async () => {
    const host = new Host();
    const proxy = pathInvokerToProxy(objectToPathInvoker(host, HostBase.prototype));

    await expect(proxy.ping("round")).resolves.toBe("pong:round");
    await expect(proxy.nested.math.add(20, 22)).resolves.toBe(42);
  });
});
