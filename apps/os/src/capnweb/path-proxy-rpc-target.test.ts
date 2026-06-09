import { describe, expect, test } from "vitest";
import { PathProxyRpcTarget } from "./path-proxy-rpc-target.ts";

type TestPathProxy = Function & {
  [Symbol.dispose]: () => void;
  [key: string]: TestPathProxy;
};

describe("PathProxyRpcTarget", () => {
  test("disposes the captured server-side target from any path child", () => {
    let disposed = 0;
    const target = new PathProxyRpcTarget(() => undefined, {
      dispose() {
        disposed += 1;
      },
    }) as unknown as TestPathProxy;

    target.some.child[Symbol.dispose]();

    expect(disposed).toBe(1);
  });

  test("does not synthesize RPC-visible descriptors for inherited function members", async () => {
    const calls: Array<{ args: unknown[]; path: string[] }> = [];
    const target = new PathProxyRpcTarget((input) => {
      calls.push(input);
      return { ok: true };
    }) as unknown as TestPathProxy;

    expect(Object.getOwnPropertyDescriptor(target, "bind")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(target, "call")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(target, "apply")).toBeUndefined();

    expect(target.bind).toBe(Function.prototype.bind);
    expect(target.call).toBe(Function.prototype.call);
    expect(target.apply).toBe(Function.prototype.apply);

    expect(await target.some.nested.method({ ok: true })).toEqual({ ok: true });
    expect(calls).toEqual([{ args: [{ ok: true }], path: ["some", "nested", "method"] }]);
  });
});
