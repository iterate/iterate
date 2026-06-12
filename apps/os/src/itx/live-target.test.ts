// The one live wrapper (live-target.ts): functions call, classes
// member-replay. Plain Node tests — the cloudflare:workers RpcTarget base is
// shimmed (vitest.config.ts), and the wrapper itself is pure dispatch.

import { describe, expect, test } from "vitest";
import { LiveCallableCapability, resolveLiveCapability } from "./live-target.ts";

describe("LiveCallableCapability", () => {
  test("an empty path calls the function with the args", async () => {
    const seen: unknown[][] = [];
    const wrapper = new LiveCallableCapability((...args: unknown[]) => {
      seen.push(args);
      return "called";
    });
    await expect(wrapper.call({ args: [1, "two"], path: [] })).resolves.toBe("called");
    expect(seen).toEqual([[1, "two"]]);
  });

  test("a member path replays onto the target's members (the call-less-class shape)", async () => {
    // A capnweb stub of a call-less RpcTarget is a callable proxy whose
    // property accesses materialize its members; this local stand-in has the
    // same shape — a function carrying a member tree.
    const target = Object.assign(() => "root", {
      chat: { post: (input: { text: string }) => ({ posted: input.text }) },
    });
    const wrapper = new LiveCallableCapability(target as never);
    await expect(wrapper.call({ args: [{ text: "hi" }], path: ["chat", "post"] })).resolves.toEqual(
      { posted: "hi" },
    );
    // And the same wrapper still calls the function itself on an empty path.
    await expect(wrapper.call({ args: [], path: [] })).resolves.toBe("root");
  });

  test("a member miss on a memberless function is a plain path error", async () => {
    const wrapper = new LiveCallableCapability(() => 42);
    await expect(wrapper.call({ args: [], path: ["nope"] })).rejects.toThrow(
      /did not resolve to a function/,
    );
  });

  test("retains a dup of stub-shaped functions; dispose releases it", () => {
    const log: string[] = [];
    const makeStub = (label: string) =>
      Object.assign(() => label, {
        dup: () => makeStub(`${label}+dup`),
        [Symbol.dispose]: () => log.push(label),
      });
    const wrapper = new LiveCallableCapability(makeStub("fn") as never);
    wrapper[Symbol.dispose]();
    expect(log).toEqual(["fn+dup"]);
  });
});

describe("resolveLiveCapability", () => {
  test("local bare functions wrap; the wrapper speaks call()", async () => {
    const resolved = (await resolveLiveCapability(
      (async (a: number, b: number) => a + b) as never,
    )) as LiveCallableCapability;
    expect(resolved).toBeInstanceOf(LiveCallableCapability);
    await expect(resolved.call({ args: [40, 2], path: [] })).resolves.toBe(42);
  });

  test("plain objects and addresses pass through untouched", async () => {
    const plain = { deep: { thought: () => 42 } };
    await expect(resolveLiveCapability(plain)).resolves.toBe(plain);
    const address = { type: "rpc" as const, worker: { binding: "AI", type: "binding" as const } };
    await expect(resolveLiveCapability(address)).resolves.toBe(address);
  });
});
