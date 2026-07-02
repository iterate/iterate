import { describe, expect, test, vi } from "vitest";
import { withOwnedRpcSession } from "./utils.ts";

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
  test("dups the target and every owned stub", () => {
    const disposed: string[] = [];
    const target = createStub("target", disposed);
    const root = createStub("root", disposed);
    const session = createStub("session", disposed);

    const wrapped = withOwnedRpcSession(target, root, session);
    const duplicate = wrapped.dup();

    duplicate[Symbol.dispose]();
    expect(disposed).toEqual(["target:dup", "root:dup", "session:dup"]);

    wrapped[Symbol.dispose]();
    expect(disposed).toEqual([
      "target:dup",
      "root:dup",
      "session:dup",
      "target",
      "root",
      "session",
    ]);
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
});
