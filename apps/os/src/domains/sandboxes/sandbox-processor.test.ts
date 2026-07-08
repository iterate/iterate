import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  it("folds a pet's whole life: created → running → stopped → running → destroyed", async () => {
    const processor = sandboxProcessor();
    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/create-requested", { instanceType: "basic" }),
        event("events.iterate.com/sandbox/created", { instanceType: "basic" }),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { status: "created", instanceType: "basic", lastBackupId: null },
    });

    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/started"),
        event("events.iterate.com/sandbox/backup-created", { backupId: "bkp-1" }),
        event("events.iterate.com/sandbox/stopped"),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { status: "stopped", instanceType: "basic", lastBackupId: "bkp-1" },
    });

    await processor.ingest({
      events: [
        // An implicit wake: started without a start-requested.
        event("events.iterate.com/sandbox/started"),
        event("events.iterate.com/sandbox/workspace-restored", { backupId: "bkp-1" }),
        event("events.iterate.com/sandbox/destroy-requested"),
        event("events.iterate.com/sandbox/destroyed"),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { status: "destroyed", instanceType: "basic" },
    });
  });

  it("destroyed is terminal — a late-delivered stopped cannot resurrect the status", async () => {
    const processor = sandboxProcessor();
    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/created", { instanceType: "lite" }),
        event("events.iterate.com/sandbox/destroyed"),
        // The SDK delivers a stop that happened while the Durable Object was
        // hibernated on the NEXT wake — after the destroy already landed.
        event("events.iterate.com/sandbox/stopped"),
      ],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { status: "destroyed" },
    });
  });

  it("folds the configured env map (later configs merge over earlier)", async () => {
    const processor = sandboxProcessor();
    await processor.ingest({
      events: [
        event("events.iterate.com/sandbox/configured", {
          env: { GH_TOKEN: 'getSecret({ path: "/secrets/gh" })', FOO: "bar" },
        }),
        event("events.iterate.com/sandbox/configured", {
          env: { OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai" })', FOO: "baz" },
        }),
      ],
      streamMaxOffset: nextOffset,
    });
    const snap: { state: z.infer<typeof SandboxProcessorContract.stateSchema> } =
      await processor.snapshot();
    expect(snap.state.env).toEqual({
      GH_TOKEN: 'getSecret({ path: "/secrets/gh" })',
      OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai" })',
      FOO: "baz",
    });
  });

  it("ignores events outside its catalog", async () => {
    const processor = sandboxProcessor();
    await processor.ingest({
      events: [event("events.iterate.com/agent/turn-started")],
      streamMaxOffset: nextOffset,
    });
    await expect(processor.snapshot()).resolves.toMatchObject({
      state: { lastBackupId: null, status: "created" },
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
