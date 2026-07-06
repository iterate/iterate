import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";
import { SandboxProcessor } from "./sandbox-processor-implementation.ts";

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

let nextOffset = 0;
function event(type: string, payload: Record<string, unknown> = {}): StreamEvent {
  nextOffset += 1;
  return { type, payload, createdAt: new Date(nextOffset).toISOString(), offset: nextOffset };
}

function sandboxProcessor() {
  nextOffset = 0;
  return new SandboxProcessor({ stream: neverStream });
}

describe("SandboxProcessor", () => {
  it("folds the idle-out/restore lifecycle into running + lastBackupId", async () => {
    const processor = sandboxProcessor();
    // The sequence observed live on preview_7: boot, clone, idle-out snapshot,
    // stop, wake, restore of that same snapshot.
    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/container-started"),
        event("events.iterate.com/sandbox/workspace-cloned"),
        event("events.iterate.com/sandbox/backup-created", { backupId: "bkp-1" }),
        event("events.iterate.com/sandbox/container-stopped"),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { lastBackupId: "bkp-1", running: false },
    });

    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/container-started"),
        event("events.iterate.com/sandbox/workspace-restored", { backupId: "bkp-1" }),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { lastBackupId: "bkp-1", running: true },
    });
  });

  it("ignores events outside its catalog", async () => {
    const processor = sandboxProcessor();
    await processor.ingest({
      events: [event("events.iterate.com/agent/turn-started")],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { lastBackupId: null, running: false },
    });
  });
});

describe("SandboxProcessorContract.buildEvent", () => {
  it("validates lifecycle payloads against the catalog", () => {
    expect(
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/backup-created",
        payload: { backupId: "bkp-1" },
      }),
    ).toMatchObject({ payload: { backupId: "bkp-1" } });

    expect(() =>
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/backup-created",
        // @ts-expect-error — the wrong payload shape must fail at runtime too
        payload: { wrong: true },
      }),
    ).toThrow();
  });
});
