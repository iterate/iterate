import { describe, expect, test, vi } from "vitest";
import { withOwnedRpcSession } from "./owned-rpc-session.ts";

type TestStub = {
  dup(): TestStub;
  name: string;
  [Symbol.dispose](): void;
};

function createStub(name: string, disposed: string[]): TestStub {
  return {
    name,
    dup: vi.fn(() => createStub(`${name}:dup`, disposed)),
    [Symbol.dispose]: vi.fn(() => {
      disposed.push(name);
    }),
  };
}

describe("withOwnedRpcSession", () => {
  test("a failed duplicate does not keep the session alive", () => {
    const disposed: string[] = [];
    const target = createStub("target", disposed);
    target.dup = () => {
      throw new Error("duplicate refused");
    };
    const session = createStub("session", disposed);
    const wrapped = withOwnedRpcSession(target, session);

    expect(() => wrapped.dup()).toThrow("duplicate refused");
    wrapped[Symbol.dispose]();
    expect(disposed).toEqual(["target", "session"]);
  });

  test("releases each leaf while retaining shared parents until the last duplicate", () => {
    const disposed: string[] = [];
    const target = createStub("target", disposed);
    const root = createStub("root", disposed);
    const session = createStub("session", disposed);

    const wrapped = withOwnedRpcSession(target, root, session);
    const duplicate = wrapped.dup();

    expect(target.dup).toHaveBeenCalledOnce();
    expect(root.dup).not.toHaveBeenCalled();
    expect(session.dup).not.toHaveBeenCalled();

    duplicate[Symbol.dispose]();
    expect(disposed).toEqual(["target:dup"]);

    wrapped[Symbol.dispose]();
    expect(disposed).toEqual(["target:dup", "target", "root", "session"]);
  });

  test("attempts every disposer before rethrowing", () => {
    const error = new Error("target dispose failed");
    const calls: string[] = [];
    const target = {
      dup: vi.fn(() => target),
      [Symbol.dispose]: vi.fn(() => {
        calls.push("target");
        throw error;
      }),
    };
    const root = {
      dup: vi.fn(() => root),
      [Symbol.dispose]: vi.fn(() => calls.push("root")),
    };
    const session = {
      dup: vi.fn(() => session),
      [Symbol.dispose]: vi.fn(() => calls.push("session")),
    };

    const wrapped = withOwnedRpcSession(target, root, session);

    expect(() => wrapped[Symbol.dispose]()).toThrow(error);
    expect(calls).toEqual(["target", "root", "session"]);
  });

  test("does not retain extra parent references across repeated duplicates", () => {
    const disposed: string[] = [];
    const target = createStub("target", disposed);
    const root = createStub("root", disposed);
    const session = createStub("session", disposed);
    const wrapped = withOwnedRpcSession(target, root, session);
    const first = wrapped.dup();
    const second = first.dup();

    first[Symbol.dispose]();
    second[Symbol.dispose]();
    expect(disposed).toEqual(["target:dup", "target:dup:dup"]);
    expect(root.dup).not.toHaveBeenCalled();
    expect(session.dup).not.toHaveBeenCalled();

    wrapped[Symbol.dispose]();
    expect(disposed).toEqual(["target:dup", "target:dup:dup", "target", "root", "session"]);
  });
});
