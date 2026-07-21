import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import type { Project } from "../../itx-api.generated.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorReads,
  type RunScriptCommand,
} from "./capability-host-processor-implementation.ts";

const SCRIPT_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_SETTLED = "events.iterate.com/capability-host/script-run-settled";

describe("CapabilityHostProcessor.runScript", () => {
  it("rejoins one durable execution after losing the outer acknowledgement", async () => {
    const stream = new MemoryStream("/agents/test");
    const predicateWaiters: {
      predicate: (event: StreamEvent) => boolean;
      resolve: () => void;
    }[] = [];
    const reads: CapabilityHostProcessorReads = {
      snapshot: async () =>
        ({
          offset: 1,
          state: { birthCertificate: { config: {}, fallback: null } },
        }) as never,
      waitUntilEvent: (input) => {
        if ("offset" in input) throw new Error("offset waiter not used");
        return new Promise<void>((resolve, reject) => {
          if (input.signal?.aborted === true) {
            reject(input.signal.reason);
            return;
          }
          const abort = () => reject(input.signal?.reason);
          input.signal?.addEventListener("abort", abort, { once: true });
          predicateWaiters.push({
            predicate: input.predicate,
            resolve: () => {
              input.signal?.removeEventListener("abort", abort);
              resolve();
            },
          });
        });
      },
    };
    const processor = new CapabilityHostProcessor({
      stream,
      path: stream.path,
      projectId: "prj_test",
      itx: {} as Project,
      reads,
      scriptExecutionEntrypoint: {
        run: async () => {
          throw new Error("the runner owns execution; this method only journals and waits");
        },
      },
    });
    const command: RunScriptCommand = {
      code: "async () => 42",
      executionId: "exec-stable",
      expiresAt: Date.now() + 60_000,
    };

    const firstCall = processor.runScript(command);
    await vi.waitFor(() => {
      expect(stream.events.some((event) => event.type === SCRIPT_REQUESTED)).toBe(true);
    });
    expect(stream.events.find((event) => event.type === SCRIPT_REQUESTED)).toMatchObject({
      idempotencyKey: "capability-host/script-run-requested@exec-stable",
      payload: command,
    });

    const [settled] = await stream.append({
      type: SCRIPT_SETTLED,
      idempotencyKey: "capability-host/script-run-settled@exec-stable",
      payload: {
        executionId: command.executionId,
        settlement: { status: "succeeded", result: 42 },
      },
    });
    const firstWaiter = predicateWaiters.shift()!;
    expect(firstWaiter.predicate(settled!)).toBe(true);
    firstWaiter.resolve();

    await expect(firstCall).resolves.toEqual({
      completedEvent: settled,
      executionId: command.executionId,
      result: 42,
    });
    await expect(processor.runScript(command)).resolves.toEqual({
      completedEvent: settled,
      executionId: command.executionId,
      result: 42,
    });
    expect(stream.events.filter((event) => event.type === SCRIPT_REQUESTED)).toHaveLength(1);
  });
});
