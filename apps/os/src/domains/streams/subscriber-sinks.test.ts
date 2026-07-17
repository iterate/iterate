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
    const disposeAuthorityRoot = vi.fn();

    const retained = retainWakeHandshakeResponse({
      onDeliveryError: vi.fn(),
      onDisposed: disposeAuthorityRoot,
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
    expect(disposeAuthorityRoot).toHaveBeenCalledOnce();
  });

  it("disposes the RPC result and authority root when the handshake is invalid", () => {
    const disposeResult = vi.fn();
    const disposeAuthorityRoot = vi.fn();

    expect(() =>
      retainWakeHandshakeResponse({
        onDeliveryError: vi.fn(),
        onDisposed: disposeAuthorityRoot,
        value: {
          checkpointOffset: -1,
          sink: () => {},
          [Symbol.dispose]: disposeResult,
        },
      }),
    ).toThrow("checkpointOffset");
    expect(disposeResult).toHaveBeenCalledOnce();
    expect(disposeAuthorityRoot).toHaveBeenCalledOnce();
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
  it("acquires and releases a fresh authority lease for each push delivery", async () => {
    const received: StreamPushEventBatch[] = [];
    const acquired: Array<{
      disposeRawRoot: ReturnType<typeof vi.fn>;
      releaseLease: ReturnType<typeof vi.fn>;
    }> = [];
    const acquireAuthorityRoot = vi.fn(() => {
      const disposeRawRoot = vi.fn();
      const releaseLease = vi.fn();
      acquired.push({ disposeRawRoot, releaseLease });
      return {
        root: {
          [Symbol.dispose]: disposeRawRoot,
          receive: async (input: StreamPushEventBatch) => {
            received.push(input);
          },
        },
        [Symbol.dispose]: releaseLease,
      };
    });
    const loopback = vi.fn(() => {
      throw new Error("push delivery must not dial the ItxEntrypoint loopback");
    });
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: { ItxEntrypoint: loopback },
      acquireAuthorityRoot,
      onDurableDeliveryError: vi.fn(),
    });

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch]);
    expect(acquireAuthorityRoot).toHaveBeenCalledTimes(1);
    expect(acquired[0]!.releaseLease).toHaveBeenCalledOnce();
    expect(acquired[0]!.disposeRawRoot).not.toHaveBeenCalled();
    expect(loopback).not.toHaveBeenCalled();

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch, batch]);
    expect(acquireAuthorityRoot).toHaveBeenCalledTimes(2);
    expect(acquired[0]!.releaseLease).toHaveBeenCalledOnce();
    expect(acquired[1]!.releaseLease).toHaveBeenCalledOnce();
    expect(acquired[1]!.disposeRawRoot).not.toHaveBeenCalled();
    expect(loopback).not.toHaveBeenCalled();
  });

  it("releases the push authority lease when delivery rejects", async () => {
    const rejection = new Error("receiver rejected the batch");
    const releaseLease = vi.fn();
    const disposeRawRoot = vi.fn();
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      acquireAuthorityRoot: () => ({
        root: {
          [Symbol.dispose]: disposeRawRoot,
          receive: async () => Promise.reject(rejection),
        },
        [Symbol.dispose]: releaseLease,
      }),
      onDurableDeliveryError: vi.fn(),
    });

    await expect(dial.push(["receive"], batch)).rejects.toBe(rejection);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(disposeRawRoot).not.toHaveBeenCalled();
  });
});
