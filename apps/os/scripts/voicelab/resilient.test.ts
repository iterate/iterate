import { describe, expect, test, vi } from "vitest";
import type { Stream, StreamConnectionHandle, StreamEventBatch } from "iterate/sdk";
import { openResilientConnection } from "./resilient.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function handle() {
  return {
    close: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

describe("openResilientConnection ownership", () => {
  test("closes and disposes a superseded generation", async () => {
    const first = handle();
    const second = handle();
    let deliver: ((batch: StreamEventBatch) => void) | undefined;
    const stream = {
      openConnection: vi
        .fn()
        .mockImplementationOnce(async (options: { processEventBatch: typeof deliver }) => {
          deliver = options.processEventBatch;
          return first;
        })
        .mockResolvedValueOnce(second),
    };
    const connection = await openResilientConnection(stream as unknown as Stream, {
      connectionKey: "test",
      eventTypes: ["event"],
      onEvents: vi.fn(),
      recycleAfterBatches: 1,
      verbose: false,
    });
    deliver?.({ events: [], scannedThroughOffset: 0 } as unknown as StreamEventBatch);
    await vi.waitFor(() => expect(stream.openConnection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce();
    connection[Symbol.dispose]();
    expect(second.close).toHaveBeenCalledOnce();
    expect(second[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  test("closes and disposes a generation that resolves after close", async () => {
    const first = handle();
    const late = handle();
    const next = deferred<StreamConnectionHandle>();
    let deliver: ((batch: StreamEventBatch) => void) | undefined;
    const stream = {
      openConnection: vi
        .fn()
        .mockImplementationOnce(async (options: { processEventBatch: typeof deliver }) => {
          deliver = options.processEventBatch;
          return first;
        })
        .mockReturnValueOnce(next.promise),
    };
    const connection = await openResilientConnection(stream as unknown as Stream, {
      connectionKey: "test",
      eventTypes: ["event"],
      onEvents: vi.fn(),
      recycleAfterBatches: 1,
      verbose: false,
    });
    deliver?.({ events: [], scannedThroughOffset: 0 } as unknown as StreamEventBatch);
    await vi.waitFor(() => expect(stream.openConnection).toHaveBeenCalledTimes(2));
    connection.close();
    next.resolve(late as unknown as StreamConnectionHandle);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(first.close).toHaveBeenCalledOnce();
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(late[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});
