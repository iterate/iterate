import { afterEach, describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { ItxAuthenticationError } from "../auth.ts";
import type { WideLogEvent } from "../observability/wide-log.ts";
import { recordedSpans, resetRecordedSpans } from "../test/cloudflare-workers-shim.ts";
import { createItxRpcSessionOptions, itxRpcMethod } from "./itx-observability.ts";

afterEach(() => {
  resetRecordedSpans();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ITX observability", () => {
  it("names RPCs by target and method without exposing arbitrary property names", () => {
    class ProjectsRpcTarget {
      create() {}
    }

    expect(itxRpcMethod({ path: ["create"], target: new ProjectsRpcTarget() })).toBe(
      "Projects.create",
    );
    expect(itxRpcMethod({ path: ["projects", "get"], target: {} })).toBe("Object.call");
    expect(itxRpcMethod({ path: ["customer@example.com"], target: {} })).toBe("Object.call");
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

    expect(itxRpcMethod({ path: ["run"], target })).toBe("Rpc.call");
  });

  it("emits one linked operation event for one successful RPC", async () => {
    class ProjectsRpcTarget {
      get() {}
    }
    const events: WideLogEvent[] = [];
    vi.spyOn(console, "log").mockImplementation((event) => void events.push(event as WideLogEvent));
    const session = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_test",
      parentLogId: "log_handshake",
    });

    await expect(
      session.onCall!({ path: ["get"], target: new ProjectsRpcTarget() }, async () => "result"),
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
    expect(recordedSpans).toEqual([
      {
        name: "itx Projects.get",
        attributes: {
          "itx.call.id": events[0]!.log.id,
          "itx.outcome": "ok",
          "itx.session.id": "itx_session_test",
          "itx.transport": "websocket",
          "rpc.method": "Projects.get",
          "rpc.system": "capnweb",
        },
      },
    ]);
  });

  it("records a safe event and returns an authoritative correlated error", async () => {
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

    const correlated = await session.onCall!({ path: ["run"], target: {} }, async () => {
      throw failure;
    }).catch((error: unknown) => error);

    expect(events[0]).toMatchObject({
      message: "itx_rpc",
      outcome: "error",
      error: { name: "Error" },
    });
    expect(correlated).toBeInstanceOf(Error);
    expect(correlated).not.toBe(failure);
    expect(correlated).toMatchObject({ name: "Error", message: "private customer prompt" });
    expect((correlated as Error & { itxCallId: string }).itxCallId).toBe(events[0]!.log.id);
    expect(Object.keys(correlated as object)).toContain("itxCallId");
    expect(JSON.stringify(events[0])).not.toContain("private customer prompt");
    expect(recordedSpans[0]).toMatchObject({
      name: "itx Object.call",
      attributes: { "itx.outcome": "error" },
    });
  });

  it("classifies rejected credentials as a client error without polluting server-error logs", async () => {
    const events: WideLogEvent[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((event) => void events.push(event as WideLogEvent));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_invalid_auth",
      parentLogId: "log_handshake",
    });

    await expect(
      session.onCall!(
        {
          path: ["authenticate"],
          target: new (class UnauthenticatedOsRpcTarget {
            authenticate() {}
          })(),
        },
        async () => {
          throw new ItxAuthenticationError();
        },
      ),
    ).rejects.toThrow("missing or invalid auth");

    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      message: "itx_rpc",
      outcome: "client_error",
      error: { name: "Error" },
      itx: { method: "UnauthenticatedOs.authenticate" },
    });
    expect(recordedSpans[0]).toMatchObject({
      name: "itx UnauthenticatedOs.authenticate",
      attributes: { "itx.outcome": "client_error" },
    });
  });

  it("classifies a modeled stream lifecycle loss as unavailable, not a server error", async () => {
    const events: WideLogEvent[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((event) => void events.push(event as WideLogEvent));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_rollover",
      parentLogId: "log_handshake",
    });

    const rejection = await session.onCall!({ path: ["waitForEvent"], target: {} }, async () => {
      throw new Error("stream-unavailable: deployment reset");
    }).catch((caught: unknown) => caught);

    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      message: "itx_rpc",
      outcome: "unavailable",
      error: { name: "Error" },
    });
    expect(rejection).toMatchObject({
      message: "stream-unavailable: deployment reset",
    });
    expect(recordedSpans[0]).toMatchObject({
      attributes: { "itx.outcome": "unavailable" },
    });
  });

  it.each([
    {
      label: "a frozen pre-tagged Error",
      thrown: Object.freeze(Object.assign(new Error("expected failure"), { itxCallId: "spoofed" })),
    },
    { label: "a non-Error value", thrown: "private thrown value" },
    {
      label: "a hostile Error proxy",
      thrown: new Proxy(new Error("private proxy message"), {
        getPrototypeOf: () => {
          throw new Error("prototype denied");
        },
      }),
    },
  ])("normalizes $label before transport", async ({ thrown }) => {
    const events: WideLogEvent[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (event) => void events.push(event as WideLogEvent),
    );
    const session = createItxRpcSessionOptions({
      transport: "http",
      sessionId: "itx_session_normalized_error",
      parentLogId: "log_batch",
    });

    const correlated = await session.onCall!({ path: ["run"], target: {} }, async () => {
      throw thrown;
    }).catch((error: unknown) => error);

    expect(correlated).toBeInstanceOf(Error);
    expect((correlated as Error & { itxCallId: string }).itxCallId).toBe(events[0]!.log.id);
    expect(Object.keys(correlated as object)).toContain("itxCallId");
    expect((correlated as Error).message).not.toContain("private thrown value");
  });

  it("delivers the call ID with an error across a real Cap'n Web transport", async () => {
    const source = Object.assign(new Error("expected test failure", { cause: "private cause" }), {
      extra: "private property",
    });
    source.name = "PrivateError";
    source.stack = "private server stack";
    class Main extends RpcTarget {
      fail() {
        throw source;
      }
    }

    const events: WideLogEvent[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (event) => void events.push(event as WideLogEvent),
    );
    const options = createItxRpcSessionOptions({
      transport: "websocket",
      sessionId: "itx_session_transport_error",
      parentLogId: "log_handshake",
    });
    const channel = new MessageChannel();
    const server = newMessagePortRpcSession(channel.port1, new Main(), options);
    const remote = newMessagePortRpcSession<{ fail(): Promise<unknown> }>(channel.port2);
    try {
      const failure = await remote.fail().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("Error");
      expect((failure as Error).message).toBe("expected test failure");
      expect((failure as Error & { itxCallId: string }).itxCallId).toBe(events[0]!.log.id);
      expect(Object.keys(failure as object)).toContain("itxCallId");
      expect(Reflect.get(failure as object, "cause")).toBeUndefined();
      expect(Reflect.get(failure as object, "extra")).toBeUndefined();
      expect((failure as Error).stack).not.toContain("private server stack");
    } finally {
      remote[Symbol.dispose]();
      server[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    }
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
