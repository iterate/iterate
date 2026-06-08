import { RpcPromise, RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test } from "vitest";
import { liftLocalProxies, localProxyCaller } from "./local-proxy-wrapper.js";

describe("liftLocalProxies", () => {
  test("preserves direct calls through Cap'n Web promise properties", async () => {
    class Project extends RpcTarget {
      describe() {
        return { id: "proj_123" };
      }
    }

    class Projects extends RpcTarget {
      get(id: string) {
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

  test("supports pipelined SDK-shaped calls through a pending local proxy marker", async () => {
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

  test("supports SDK-shaped calls through a Cap'n Web promise marker", async () => {
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
