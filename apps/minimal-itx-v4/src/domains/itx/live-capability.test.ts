import { describe, expect, it, vi } from "vitest";
import { deepRetainRpcStubs, retainLiveCapabilityProvider } from "./live-capability.ts";

describe("live capability retention", () => {
  it("deep-copies plain provider trees and releases only duped RPC stubs", () => {
    class LocalDisposable {
      dispose = vi.fn();

      [Symbol.dispose]() {
        this.dispose();
      }
    }

    const originalDispose = vi.fn();
    const retainedDispose = vi.fn();
    class FakeRpcStub {
      [Symbol.dispose] = originalDispose;
      call = () => "original";
      dup = vi.fn(() => ({
        [Symbol.dispose]: retainedDispose,
        call: () => "retained",
      }));
    }

    const stub = new FakeRpcStub();
    const local = new LocalDisposable();

    const retained = deepRetainRpcStubs({
      local,
      nested: { stub },
    });

    expect(retained.value).not.toBe(stub);
    expect(retained.value.local).toBe(local);
    expect(retained.value.nested.stub).not.toBe(stub);
    expect(retained.value.nested.stub.call()).toBe("retained");
    expect(stub.dup).toHaveBeenCalledOnce();

    retained.dispose();
    retained.dispose();

    expect(retainedDispose).toHaveBeenCalledOnce();
    expect(originalDispose).not.toHaveBeenCalled();
    expect(local.dispose).not.toHaveBeenCalled();
  });

  it("does not treat plain objects with own dup properties as RPC stubs", () => {
    const plainObjectWithDup = {
      dup: vi.fn(() => {
        throw new Error("plain object dup should not be called");
      }),
      value: 42,
    };

    const retained = deepRetainRpcStubs({ plainObjectWithDup });

    expect(retained.value.plainObjectWithDup).not.toBe(plainObjectWithDup);
    expect(retained.value.plainObjectWithDup.value).toBe(42);
    expect(retained.value.plainObjectWithDup.dup).toBe(plainObjectWithDup.dup);
    expect(plainObjectWithDup.dup).not.toHaveBeenCalled();
  });

  it("keeps path-call dispatch separate from retention", async () => {
    const invokeCapability = vi.fn(({ args, path }) => ({
      args,
      path,
    }));
    const capability = retainLiveCapabilityProvider({ invokeCapability });

    await expect(Promise.resolve(capability.invoke(["tools", "echo"], ["hello"]))).resolves.toEqual(
      {
        args: ["hello"],
        path: ["tools", "echo"],
      },
    );
    expect(invokeCapability).toHaveBeenCalledOnce();
  });
});
