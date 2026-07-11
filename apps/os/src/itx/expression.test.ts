import { RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import { evaluateItxExpression } from "./expression.ts";

/**
 * A fake transport stub: object-like, disposable, NOT an RpcTarget — the
 * shape the evaluator sees when a walk crosses workerd loopback RPC.
 */
function fakeStub<T extends object>(members: T, disposed: string[], name: string) {
  return {
    ...members,
    [Symbol.dispose]() {
      disposed.push(name);
    },
  };
}

describe("evaluateItxExpression stub hygiene", () => {
  it("disposes intermediate stubs, keeps the final value and its receiver", async () => {
    // Models the wake dial's walk: root → collection → item → processor →
    // call. Every hop is a disposable "stub"; only the walk's ANSWER (and the
    // receiver kept for `this`-preserving invocation) may stay alive —
    // dropping the rest un-disposed is exactly the "An RPC stub was not
    // disposed properly" logspam observed at every agent birth.
    const disposed: string[] = [];
    const processor = fakeStub({ wake: (n: number) => ({ checkpoint: n }) }, disposed, "processor");
    const agent = fakeStub({ processor }, disposed, "agent");
    const collection = fakeStub({ get: () => agent }, disposed, "collection");
    const root = { agents: collection };

    const { value } = await evaluateItxExpression(root, [
      "agents",
      ["get", "/agents/x"],
      "processor",
      ["wake", 7],
    ]);

    expect(value).toEqual({ checkpoint: 7 });
    // collection and agent were pure intermediates; processor was the final
    // call's target (consumed by the call — receiver is undefined after a
    // call step) and is disposed too.
    expect(disposed.sort()).toEqual(["agent", "collection", "processor"]);
  });

  it("keeps the receiver alive when the final step is a property read", async () => {
    const disposed: string[] = [];
    const item = fakeStub({ leafMethod: () => "leaf" }, disposed, "item");
    const collection = fakeStub({ get: () => item }, disposed, "collection");
    const root = { things: collection };

    const { receiver, value } = await evaluateItxExpression(root, [
      "things",
      ["get", "k"],
      "leafMethod",
    ]);

    // The caller invokes `value` with `receiver` as `this` — item must
    // survive; collection was an intermediate.
    expect(receiver).toBe(item);
    expect(typeof value).toBe("function");
    expect(disposed).toEqual(["collection"]);
  });

  it("never disposes local RpcTargets — some carry destructive Symbol.dispose", async () => {
    // In-process evaluation walks REAL targets (instanceof RpcTarget), and at
    // least one (CapabilityProvisionRpcTarget) has a Symbol.dispose that
    // REVOKES the mount. The stub-hygiene sweep must be gated off them.
    const disposed: string[] = [];
    class LocalTarget extends RpcTarget {
      constructor(private name: string) {
        super();
      }
      [Symbol.dispose]() {
        disposed.push(this.name);
      }
      get inner() {
        return new LocalTarget("inner");
      }
      answer() {
        return 42;
      }
    }
    const root = { local: new LocalTarget("outer") };

    const { value } = await evaluateItxExpression(root, ["local", "inner", ["answer"]]);
    expect(value).toBe(42);
    expect(disposed).toEqual([]);
  });

  it("disposes everything it materialized when a step throws", async () => {
    const disposed: string[] = [];
    const broken = fakeStub(
      {
        explode: () => {
          throw new Error("boom");
        },
      },
      disposed,
      "broken",
    );
    const collection = fakeStub({ get: () => broken }, disposed, "collection");
    const root = { things: collection };

    await expect(
      evaluateItxExpression(root, ["things", ["get", "k"], ["explode"]]),
    ).rejects.toThrow("boom");
    expect(disposed.sort()).toEqual(["broken", "collection"]);
  });

  it("never disposes the root — the caller owns it", async () => {
    const disposed: string[] = [];
    const root = fakeStub({ leaf: () => "ok" }, disposed, "root");
    const { value } = await evaluateItxExpression(root, [["leaf"]]);
    expect(value).toBe("ok");
    expect(disposed).toEqual([]);
  });
});
