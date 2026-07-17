import { describe, expect, it, vi } from "vitest";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  StreamSubscriberPing,
} from "iterate/processors";
import { createSubscriberDial, retainWakeHandshakeResponse } from "./subscriber-sinks.ts";

function remoteCallback<Arg, Result>(implementation: (arg: Arg) => Result) {
  const rawDispose = vi.fn();
  const duplicateDispose = vi.fn();
  const duplicate = Object.assign((arg: Arg) => implementation(arg), {
    [Symbol.dispose]: duplicateDispose,
  });
  const raw = Object.assign((arg: Arg) => implementation(arg), {
    dup: vi.fn(() => duplicate),
    [Symbol.dispose]: rawDispose,
  });
  return { duplicateDispose, raw, rawDispose };
}

describe("wake-handshake RPC ownership", () => {
  it("retains every returned capability and disposes the original RPC result", async () => {
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {});
    const getRuntimeState = remoteCallback<void, { snapshot: { offset: number; state: object } }>(
      () => ({ snapshot: { offset: 17, state: {} } }),
    );
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({
        t0,
        t1: t0 + 1,
        t2: t0 + 2,
      }),
    );
    const disposeResult = vi.fn(() => {
      sink.raw[Symbol.dispose]();
      getRuntimeState.raw[Symbol.dispose]();
      ping.raw[Symbol.dispose]();
    });
    const retained = retainWakeHandshakeResponse({
      onDeliveryError: vi.fn(),
      value: {
        checkpointOffset: 17,
        sink: sink.raw as ProcessEventBatch,
        getRuntimeState: getRuntimeState.raw as GetProcessorRuntimeState,
        ping: ping.raw as StreamSubscriberPing,
        [Symbol.dispose]: disposeResult,
      },
    });

    expect(disposeResult).toHaveBeenCalledOnce();
    expect(sink.rawDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.rawDispose).toHaveBeenCalledOnce();
    expect(ping.rawDispose).toHaveBeenCalledOnce();
    expect(sink.raw.dup).toHaveBeenCalledOnce();
    expect(getRuntimeState.raw.dup).toHaveBeenCalledOnce();
    expect(ping.raw.dup).toHaveBeenCalledOnce();

    retained.sink({
      events: [],
      path: "/",
      projectId: "prj_test",
      scannedAfterOffset: 17,
      scannedThroughOffset: 17,
      state: {},
      streamMaxOffset: 17,
    });
    expect(await retained.getRuntimeState?.()).toEqual({
      snapshot: { offset: 17, state: {} },
    });
    expect(await retained.ping?.({ t0: 10 })).toEqual({ t0: 10, t1: 11, t2: 12 });

    retained.sink[Symbol.dispose]();
    expect(sink.duplicateDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.duplicateDispose).toHaveBeenCalledOnce();
    expect(ping.duplicateDispose).toHaveBeenCalledOnce();
  });

  it("disposes the RPC result when the handshake is invalid", () => {
    const disposeResult = vi.fn();

    expect(() =>
      retainWakeHandshakeResponse({
        onDeliveryError: vi.fn(),
        value: {
          checkpointOffset: -1,
          sink: () => {},
          [Symbol.dispose]: disposeResult,
        },
      }),
    ).toThrow("checkpointOffset");
    expect(disposeResult).toHaveBeenCalledOnce();
  });
});

const batch: StreamPushEventBatch = {
  projectId: "prj_test",
  path: "/test",
  events: [],
  streamMaxOffset: 3,
  subscriptionKey: "receiver",
  deliveryId: "receiver:3-3",
  attempt: 1,
  configuredEvent: {
    type: "events.iterate.com/stream/subscription-configured",
    offset: 2,
    createdAt: "2026-07-16T00:00:00.000Z",
    path: "/test",
    payload: {},
  },
};

describe("createSubscriberDial", () => {
  it("creates a fresh local authority root for each push delivery", async () => {
    const received: StreamPushEventBatch[] = [];
    const roots: object[] = [];
    const createAuthorityRoot = vi.fn(() => {
      const root = {
        receive: async (input: StreamPushEventBatch) => {
          received.push(input);
        },
      };
      roots.push(root);
      return root;
    });
    const loopback = vi.fn(() => {
      throw new Error("push delivery must not dial the ItxEntrypoint loopback");
    });
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: { ItxEntrypoint: loopback },
      createAuthorityRoot,
      onDurableDeliveryError: vi.fn(),
    });

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch]);
    expect(createAuthorityRoot).toHaveBeenCalledTimes(1);
    expect(loopback).not.toHaveBeenCalled();

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch, batch]);
    expect(createAuthorityRoot).toHaveBeenCalledTimes(2);
    expect(roots[0]).not.toBe(roots[1]);
    expect(loopback).not.toHaveBeenCalled();
  });

  it("preserves a push delivery rejection", async () => {
    const rejection = new Error("receiver rejected the batch");
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({
        receive: async () => Promise.reject(rejection),
      }),
      onDurableDeliveryError: vi.fn(),
    });

    await expect(dial.push(["receive"], batch)).rejects.toBe(rejection);
  });

  it("disposes an ignored object-valued push result after acknowledgement", async () => {
    const disposeResult = vi.fn();
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({
        receive: async () => ({ [Symbol.dispose]: disposeResult }),
      }),
      onDurableDeliveryError: vi.fn(),
    });

    await dial.push(["receive"], batch);
    expect(disposeResult).toHaveBeenCalledOnce();
  });

  it("keeps an acknowledged push successful when result disposal throws", async () => {
    const disposalError = new Error("native result disposal failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({
        receive: async () => ({
          [Symbol.dispose]: () => {
            throw disposalError;
          },
        }),
      }),
      onDurableDeliveryError: vi.fn(),
    });

    try {
      await expect(dial.push(["receive"], batch)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "stream push RPC result dispose failed after acknowledgement",
        { error: disposalError },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
