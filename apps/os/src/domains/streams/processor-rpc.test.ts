import { describe, expect, it, vi } from "vitest";
import type { StreamProcessorRpc } from "iterate/processors";
import {
  readProcessorRuntimeState,
  readProcessorSnapshot,
  serveProcessorRead,
  waitUntilProcessorOffset,
  type ProcessorReadHost,
} from "./processor-rpc.ts";

describe("data-only processor host RPC", () => {
  it("dispatches every read operation without returning the processor target", async () => {
    const snapshot = { offset: 12, state: { ready: true } };
    const runtimeState = { snapshot, runtime: { running: false } };
    const processor: StreamProcessorRpc<{ ready: boolean }> = {
      getRuntimeState: vi.fn(async () => runtimeState),
      snapshot: vi.fn(async () => snapshot),
      waitUntilProcessed: vi.fn(async () => undefined),
    };
    const host: ProcessorReadHost = {
      readStreamProcessor: (request) =>
        serveProcessorRead({ expectedProcessorSlug: "project", processor, request }),
    };

    await expect(readProcessorSnapshot(host, "project")).resolves.toEqual(snapshot);
    await expect(readProcessorRuntimeState(host, "project")).resolves.toEqual(runtimeState);
    await expect(
      waitUntilProcessorOffset(host, "project", { offset: 12, timeoutMs: 500 }),
    ).resolves.toBeUndefined();

    expect(processor.snapshot).toHaveBeenCalledOnce();
    expect(processor.getRuntimeState).toHaveBeenCalledOnce();
    expect(processor.waitUntilProcessed).toHaveBeenCalledWith({ offset: 12, timeoutMs: 500 });
  });

  it("rejects a processor slug the host does not explicitly expose", async () => {
    const processor: StreamProcessorRpc = {
      getRuntimeState: vi.fn(),
      snapshot: vi.fn(),
      waitUntilProcessed: vi.fn(),
    };

    await expect(
      serveProcessorRead({
        expectedProcessorSlug: "project",
        processor,
        request: { operation: "snapshot", processorSlug: "email" },
      }),
    ).rejects.toThrow('processor host does not expose "email"; expected "project"');
    expect(processor.snapshot).not.toHaveBeenCalled();
  });
});
