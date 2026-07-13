import { afterEach, describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { WideLogEvent } from "../observability/wide-log.ts";
import { createItxRpcSessionOptions, itxRpcMethod } from "./itx-observability.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ITX observability", () => {
  it("names RPCs by target and method without exposing arbitrary property names", () => {
    class ProjectsRpcTarget {}

    expect(itxRpcMethod({ path: ["create"], target: new ProjectsRpcTarget() })).toBe(
      "Projects.create",
    );
    expect(itxRpcMethod({ path: ["projects", "get"], target: {} })).toBe("projects.get");
    expect(itxRpcMethod({ path: ["customer@example.com"], target: {} })).toBe("Object.property");
  });

  it("falls back without invoking a target's constructor property", () => {
    const target = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("reflection denied");
        },
      },
    );

    expect(itxRpcMethod({ path: ["run"], target })).toBe("Rpc.run");
  });

  it("emits one linked operation event for one successful RPC", async () => {
    const events: WideLogEvent[] = [];
    vi.spyOn(console, "log").mockImplementation((event) => void events.push(event as WideLogEvent));
    const session = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_test",
      parentLogId: "log_handshake",
    });

    await expect(
      session.onCall!(
        { path: ["get"], target: new (class ProjectsRpcTarget {})() },
        async () => "result",
      ),
    ).resolves.toBe("result");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "itx_rpc",
      outcome: "ok",
      log: { kind: "itx_rpc", parentId: "log_handshake" },
      itx: {
        method: "Projects.get",
        rpcSystem: "capnweb",
        sessionId: "itx_session_test",
        transport: "websocket",
      },
    });
    expect(Reflect.get(events[0]!.itx as object, "callId")).toBe(events[0]!.log.id);
  });

  it("records and rethrows the original RPC error without serializing its message", async () => {
    const events: WideLogEvent[] = [];
    const failure = new Error("private customer prompt");
    vi.spyOn(console, "error").mockImplementation(
      (event) => void events.push(event as WideLogEvent),
    );
    const session = createItxRpcSessionOptions({
      transport: "http",
      sessionId: "itx_session_test",
      parentLogId: "log_batch",
    });

    await expect(
      session.onCall!({ path: ["run"], target: {} }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events[0]).toMatchObject({
      message: "itx_rpc",
      outcome: "error",
      error: { name: "Error" },
    });
    expect(JSON.stringify(events[0])).not.toContain("private customer prompt");
  });

  it("wraps direct and promise-pipelined calls once through a real message transport", async () => {
    class Child extends RpcTarget {
      double(value: number) {
        return value * 2;
      }
    }
    class Main extends RpcTarget {
      child() {
        return new Child();
      }
    }

    const events: WideLogEvent[] = [];
    vi.spyOn(console, "log").mockImplementation((event) => void events.push(event as WideLogEvent));
    const options = createItxRpcSessionOptions({
      transport: "http",
      sessionId: "itx_session_transport",
      parentLogId: "log_batch",
    });
    const channel = new MessageChannel();
    const server = newMessagePortRpcSession(channel.port1, new Main(), options);
    type Remote = { child(): Promise<{ double(value: number): Promise<number> }> };
    const remote = newMessagePortRpcSession<Remote>(channel.port2);
    try {
      await expect(remote.child().double(21)).resolves.toBe(42);
      expect(events.map((event) => event.itx?.method)).toEqual(["Main.child", "Child.double"]);
    } finally {
      remote[Symbol.dispose]();
      server[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
