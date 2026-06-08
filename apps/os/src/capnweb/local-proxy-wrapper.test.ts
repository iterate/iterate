import { RpcPromise, RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test } from "vitest";
import { liftLocalProxies, localProxyCaller } from "./local-proxy-wrapper.js";

describe("liftLocalProxies", () => {
  test("does not treat ordinary callable proxy targets as promises just because they expose then", () => {
    let thenCalls = 0;
    const rpcStub = Object.assign(() => undefined, {
      projects: {
        list: () => ({ projects: [], total: 0 }),
      },
      then: () => {
        thenCalls += 1;
        throw new Error("remote then should not be called");
      },
    });

    const lifted = liftLocalProxies(rpcStub) as typeof rpcStub;

    expect(lifted.projects.list()).toEqual({ projects: [], total: 0 });
    expect(thenCalls).toBe(0);
  });

  test("does not even read a callable RPC root then member while calling normal members", () => {
    let thenReads = 0;
    const rpcStub = Object.assign(() => undefined, {
      projects: {
        list: () => ({ projects: [], total: 0 }),
      },
    });
    Object.defineProperty(rpcStub, "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw new Error("remote then should not be read");
      },
    });

    const lifted = liftLocalProxies(rpcStub) as typeof rpcStub;

    expect(lifted.projects.list()).toEqual({ projects: [], total: 0 });
    expect(thenReads).toBe(0);
  });

  test("preserves direct calls through Cap'n Web promise properties", async () => {
    class Project extends RpcTarget {
      describe() {
        return { id: "proj_123" };
      }
    }

    class Projects extends RpcTarget {
      get(_id: string) {
        return new Project();
      }

      list(input: { limit: number }) {
        return { items: [{ id: "proj_123" }], limit: input.limit };
      }
    }

    class Context extends RpcTarget {
      get projects() {
        return new Projects();
      }
    }

    const ctx = liftLocalProxies(new RpcStub(new Context())) as {
      projects: {
        get(id: string): { describe(): Promise<unknown> };
        list(input: { limit: number }): Promise<unknown>;
      };
    };

    expect(ctx.projects).toBeInstanceOf(RpcPromise);
    await expect(ctx.projects.list({ limit: 5 })).resolves.toEqual({
      items: [{ id: "proj_123" }],
      limit: 5,
    });

    await expect(ctx.projects.get("proj_123").describe()).resolves.toEqual({ id: "proj_123" });
  });

  test("supports SDK-shaped calls through a native pending local proxy marker", async () => {
    const call = async (input: { args: unknown[]; path: string[] }) => input;
    const ctx = liftLocalProxies({
      slack: Promise.resolve(localProxyCaller(call)),
    }) as unknown as {
      slack: {
        chat: {
          postMessage(input: { text: string }): Promise<unknown>;
        };
      };
    };

    await expect(ctx.slack.chat.postMessage({ text: "hi" })).resolves.toEqual({
      args: [{ text: "hi" }],
      path: ["chat", "postMessage"],
    });
  });

  test("supports SDK-shaped calls through a pending Cap'n Web local proxy marker", async () => {
    const call = async (input: { args: unknown[]; path: string[] }) => input;

    class Context extends RpcTarget {
      get slack() {
        return localProxyCaller(call);
      }
    }

    const ctx = liftLocalProxies(new RpcStub(new Context())) as unknown as {
      slack: {
        chat: {
          postMessage(input: { text: string }): Promise<unknown>;
        };
      };
    };

    await expect(ctx.slack.chat.postMessage({ text: "hello" })).resolves.toEqual({
      args: [{ text: "hello" }],
      path: ["chat", "postMessage"],
    });
  });
});
