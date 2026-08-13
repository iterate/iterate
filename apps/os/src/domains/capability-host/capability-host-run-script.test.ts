import { describe, expect, it, vi } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import { capabilityHostCreationEvents } from "./capability-host-defaults.ts";
import {
  runCapabilityHostScript,
  type CapabilityHostScriptStream,
  type RunScriptCommand,
} from "./capability-host-script-run.ts";

const PROJECT_ID = "prj_test";
const PATH = "/agents/test";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SCRIPT_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_SETTLED = "events.iterate.com/capability-host/script-run-settled";

async function bornStream() {
  const stream = new MemoryStream(PATH);
  const creation = capabilityHostCreationEvents({ path: PATH, projectId: PROJECT_ID }).map(
    (event) =>
      event.idempotencyKey
        ? {
            ...event,
            idempotencyKey: `${event.idempotencyKey}@source-stream:${SOURCE_STREAM_ID}`,
          }
        : event,
  );
  await stream.append(...creation);
  return stream;
}

function command(now: number): RunScriptCommand {
  return {
    code: "async () => 42",
    executionId: "exec-stable",
    expiresAt: now + 60_000,
  };
}

function settleBeforeRequestAcknowledgement(
  stream: MemoryStream,
  settlement: Record<string, unknown>,
): CapabilityHostScriptStream {
  return {
    getEvent: (input) => stream.getEvent(input),
    getEvents: (input) => stream.getEvents(input),
    waitForEvent: (input) => stream.waitForEvent(input),
    append: async (...inputs: StreamEventInput[]) => {
      const committed = await stream.append(...inputs);
      const request = committed.find((event) => event.type === SCRIPT_REQUESTED);
      if (request) {
        const executionId = (request.payload as { executionId: string }).executionId;
        await stream.append({
          type: SCRIPT_SETTLED,
          idempotencyKey: `capability-host/script-run-settled@${executionId}`,
          payload: { executionId, settlement },
        });
      }
      return committed;
    },
  };
}

describe("runCapabilityHostScript", () => {
  it("replays a durable settlement that committed before the request acknowledgement", async () => {
    const now = Date.parse("2026-07-22T00:00:00Z");
    const stream = await bornStream();

    await expect(
      runCapabilityHostScript({
        command: command(now),
        now: () => now,
        path: PATH,
        stream: settleBeforeRequestAcknowledgement(stream, {
          status: "succeeded",
          result: 42,
        }),
      }),
    ).resolves.toMatchObject({ executionId: "exec-stable", result: 42 });
    expect(stream.events.filter((event) => event.type === SCRIPT_REQUESTED)).toHaveLength(1);
    expect(stream.events.filter((event) => event.type === SCRIPT_SETTLED)).toHaveLength(1);
  });

  it("returns a settlement committed before a late append acknowledgement", async () => {
    const startedAt = Date.parse("2026-07-22T00:00:00Z");
    const stream = await bornStream();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(startedAt)
      .mockReturnValue(startedAt + 75_001);

    await expect(
      runCapabilityHostScript({
        command: command(startedAt),
        now,
        path: PATH,
        stream: settleBeforeRequestAcknowledgement(stream, {
          status: "succeeded",
          result: 42,
        }),
      }),
    ).resolves.toMatchObject({ executionId: "exec-stable", result: 42 });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("surfaces a successor incarnation's orphan settlement instead of waiting on the dead one", async () => {
    const now = Date.parse("2026-07-22T00:00:00Z");
    const stream = await bornStream();

    const run = runCapabilityHostScript({
      command: command(now),
      now: () => now,
      path: PATH,
      stream,
    });
    await vi.waitFor(() => {
      expect(stream.events.filter((event) => event.type === SCRIPT_REQUESTED)).toHaveLength(1);
    });

    await stream.append({
      type: SCRIPT_SETTLED,
      idempotencyKey: "capability-host/script-run-settled@exec-stable",
      payload: {
        executionId: "exec-stable",
        settlement: {
          status: "failed",
          error:
            "Script execution orphaned: the incarnation running it went away before completing.",
          failureKind: "orphaned",
          phase: "recovery",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
        },
      },
    });

    await expect(run).rejects.toThrow("Script execution orphaned");
  });

  it("does not journal work for an unborn capability host", async () => {
    const now = Date.parse("2026-07-22T00:00:00Z");
    const stream = new MemoryStream(PATH);

    await expect(
      runCapabilityHostScript({
        command: command(now),
        now: () => now,
        path: PATH,
        stream,
      }),
    ).rejects.toThrow(`capability host at ${PATH} has not been created`);
    expect(stream.events).toEqual([]);
  });
});
