import { newMessagePortRpcSession } from "@iterate-com/capnweb";
import { describe, expect, test } from "vitest";
import { relayServedProject } from "./serve-itx.ts";

// The relay in isolation: a fake in place of the platform's Workers-RPC stub,
// a real Cap'n Web session in place of the browser's. What crosses is what
// `serveItx` puts on the wire.

type Batch = { events: Array<{ type: string }> };

function fakeScopedStub() {
  const calls: Array<[string, unknown[]]> = [];
  let onBatch: ((batch: Batch) => unknown) | undefined;
  const handle = {
    closed: false,
    close() {
      handle.closed = true;
    },
    [Symbol.dispose]() {},
  };
  const stub = {
    __describe: async () => ({ instructions: "RESTRICTED scope", children: { agent: "x" } }),
    agent: {
      __describe: async () => ({ instructions: "agent", children: {} }),
      message: async (input: unknown) => {
        calls.push(["agent.message", [input]]);
        return { offset: 7 };
      },
      kill: async () => {
        calls.push(["agent.kill", []]);
      },
      stream: {
        openConnection: async (args: { processEventBatch: (batch: Batch) => unknown }) => {
          calls.push(["agent.stream.openConnection", [Object.keys(args)]]);
          onBatch = args.processEventBatch;
          return handle;
        },
      },
    },
  };
  return { stub, calls, handle, deliver: (batch: Batch) => onBatch?.(batch) };
}

type Served = {
  __describe(): Promise<{ instructions: string; children: Record<string, string> }>;
  agent: {
    message(input: string): Promise<{ offset: number }>;
    kill(): Promise<void>;
    stream: {
      openConnection(args: {
        processEventBatch: (batch: Batch) => unknown;
      }): Promise<{ close(): Promise<void> }>;
    };
  };
  repo: { readFile(input: unknown): Promise<unknown> };
};

describe("serveItx relay", () => {
  test("relays listed members, callbacks, and returned handles; nothing else exists", async () => {
    const fake = fakeScopedStub();
    const channel = new MessageChannel();
    using _server = newMessagePortRpcSession(
      channel.port1,
      relayServedProject(fake.stub, ["agent.message", "agent.stream.openConnection"]),
    );
    using served = newMessagePortRpcSession<Served>(channel.port2);

    expect(await served.__describe()).toMatchObject({ instructions: "RESTRICTED scope" });
    expect(await served.agent.message("hi")).toEqual({ offset: 7 });

    const seen: Batch[] = [];
    const handle = await served.agent.stream.openConnection({
      processEventBatch: (batch) => {
        seen.push(batch);
      },
    });
    // The platform's callback leg: a plain function the relay made from the client's stub.
    await fake.deliver({ events: [{ type: "events.iterate.com/agents/context-added" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([{ events: [{ type: "events.iterate.com/agents/context-added" }] }]);
    // The returned stub came back wrapped, its methods callable.
    await handle.close();
    expect(fake.handle.closed).toBe(true);

    // Unlisted members do not exist on the served project.
    await expect(served.agent.kill()).rejects.toThrow();
    await expect(served.repo.readFile({ path: "x" })).rejects.toThrow();
    expect(fake.calls.map(([name]) => name)).toEqual([
      "agent.message",
      "agent.stream.openConnection",
    ]);
  });

  test("a bare root cannot be relayed", () => {
    expect(() => relayServedProject({}, ["chat"])).toThrow(/bare root "chat"/);
    expect(() => relayServedProject({}, ["agent.message", "agent.message.x"])).toThrow(
      /both a member and a branch/,
    );
  });
});
