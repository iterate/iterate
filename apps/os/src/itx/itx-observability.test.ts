import { describe, expect, it, vi } from "vitest";
import type { WideLogEvent } from "../observability/wide-log.ts";
import { createItxRpcSessionOptions, itxRpcMethod } from "./itx-observability.ts";

describe("ITX observability", () => {
  it("names RPCs by target and method without exposing arbitrary property names", () => {
    class ProjectsRpcTarget {}

    expect(itxRpcMethod({ path: ["create"], target: new ProjectsRpcTarget() })).toBe(
      "Projects.create",
    );
    expect(itxRpcMethod({ path: ["projects", "get"], target: {} })).toBe("projects.get");
    expect(itxRpcMethod({ path: ["customer@example.com"], target: {} })).toBe("Object.property");
  });

  it("emits one linked operation event for one successful RPC", async () => {
    const events: WideLogEvent[] = [];
    const waitUntil = vi.fn();
    const session = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_test",
      parentLogId: "log_handshake",
      sinks: [(event) => void events.push(event)],
      waitUntil,
    });

    await expect(
      session.onCall!(
        { path: ["get"], target: { constructor: { name: "ProjectsRpcTarget" } } },
        async () => "result",
      ),
    ).resolves.toBe("result");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "ITX Projects.get ok",
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
    const session = createItxRpcSessionOptions({
      transport: "http",
      sessionId: "itx_session_test",
      parentLogId: "log_batch",
      sinks: [(event) => void events.push(event)],
      waitUntil: () => undefined,
    });

    await expect(
      session.onCall!({ path: ["run"], target: {} }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events[0]).toMatchObject({
      message: "ITX Object.run error",
      outcome: "error",
      errors: [{ name: "Error" }],
    });
    expect(JSON.stringify(events[0])).not.toContain("private customer prompt");
  });
});
