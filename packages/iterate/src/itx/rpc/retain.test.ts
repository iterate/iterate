import { describe, expect, it, vi } from "vitest";
import { disposeIgnoredRpcResult, isThenable, retainCallback } from "./retain.ts";

describe("retainCallback", () => {
  it("passes a plain local function through, callable and disposable", () => {
    // Deliberately NOT vi.fn(): vitest mocks carry their own Symbol.dispose,
    // which would make this test exercise the wrong thing.
    const retained = retainCallback((n: number) => n * 2);
    expect(retained(21)).toBe(42);
    retained[Symbol.dispose](); // a local function has nothing to release
    expect(retained(2)).toBe(4); // …and stays callable after
    expect(retained.onRpcBroken).toBeUndefined();
  });

  it("dup()s a retainable stub and calls/disposes the duplicate, never the original", () => {
    const dispose = vi.fn();
    const duplicate = Object.assign(vi.fn(), { [Symbol.dispose]: dispose });
    const stub = Object.assign(vi.fn(), { dup: () => duplicate });
    const retained = retainCallback(stub);
    retained(1);
    expect(duplicate).toHaveBeenCalledWith(1);
    expect(stub).not.toHaveBeenCalled();
    retained[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent — owners release from several paths", () => {
    const dispose = vi.fn();
    const duplicate = Object.assign(vi.fn(), { [Symbol.dispose]: dispose });
    const stub = Object.assign(vi.fn(), { dup: () => duplicate });
    const retained = retainCallback(stub);
    retained[Symbol.dispose]();
    retained[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("forwards onRpcBroken and swallows a registration that turns out to be a pipelined fake", () => {
    // A Workers RPC property access can fabricate a method that rejects at
    // call time; registration must stay best-effort.
    const stub = Object.assign(vi.fn(), {
      onRpcBroken: () => Promise.reject(new Error("no such method")),
    });
    const retained = retainCallback(stub);
    expect(retained.onRpcBroken).toBeTypeOf("function");
    expect(() => retained.onRpcBroken!(() => {})).not.toThrow();
  });

  it("forwards a real onRpcBroken registration to the retained stub", () => {
    let handler: ((error: unknown) => void) | undefined;
    const stub = Object.assign(vi.fn(), {
      onRpcBroken: (h: (error: unknown) => void) => {
        handler = h;
      },
    });
    const retained = retainCallback(stub);
    const onBroken = vi.fn();
    retained.onRpcBroken!(onBroken);
    handler!(new Error("transport gone"));
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});

describe("isThenable", () => {
  it("detects promises and thenable-shaped stubs, rejects the rest", () => {
    expect(isThenable(Promise.resolve())).toBe(true);
    expect(isThenable({ then: () => {} })).toBe(true);
    expect(isThenable(null)).toBe(false);
    expect(isThenable(42)).toBe(false);
    expect(isThenable({})).toBe(false);
  });
});

describe("disposeIgnoredRpcResult", () => {
  it("disposes a disposable result and ignores everything else", () => {
    const dispose = vi.fn();
    disposeIgnoredRpcResult({ [Symbol.dispose]: dispose });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => disposeIgnoredRpcResult(undefined)).not.toThrow();
    expect(() => disposeIgnoredRpcResult(42)).not.toThrow();
  });
});
