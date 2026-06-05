// Failure-condition tests for the runner, in-process (deterministic, no worker).
// Proves: resume-from-snapshot + dedup, idempotent re-delivery, and durable
// at-least-once via blockProcessorUntil when a crash happens before the checkpoint.

import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./shared/event.ts";
import { implementProcessor } from "./processor.ts";
import { createProcessorRunner, type Snapshot } from "./processor-runner.ts";
import { echoExampleProcessor } from "./processors/examples/echo/implementation.ts";
import {
  echoExampleProcessorContract,
  type EchoExampleState,
} from "./processors/examples/echo/contract.ts";
import type { StreamRpc } from "./types.ts";

const iso = (ms = 0) => new Date(ms).toISOString();
const input = (offset: number): StreamEvent => ({
  type: "events.iterate.com/echo-example/input-received",
  payload: {},
  offset,
  createdAt: iso(),
});

function memoryStream() {
  const committed: StreamEvent[] = [];
  let nextOffset = 1000;
  const stream: StreamRpc = {
    append: (args) => {
      const ev: StreamEvent = { ...args.event, offset: nextOffset++, createdAt: iso(1) };
      committed.push(ev);
      return ev;
    },
    appendBatch: (args) =>
      args.events.map((event) => {
        const ev: StreamEvent = { ...event, offset: nextOffset++, createdAt: iso(1) };
        committed.push(ev);
        return ev;
      }),
    getEvent: () => undefined,
    getEvents: () => [],
    subscribe: () => {
      throw new Error("memoryStream does not implement subscribe");
    },
    runtimeState: () => {
      throw new Error("memoryStream does not implement runtimeState");
    },
    kill: () => {},
    reset: async () => {},
    reduce: () => {
      throw new Error("memoryStream does not implement reduce");
    },
  };
  return { stream, committed };
}

describe("failure conditions (in-process runner)", () => {
  it("resumes from a persisted snapshot and dedups already-processed offsets", async () => {
    const { stream, committed } = memoryStream();
    let saved: Snapshot<EchoExampleState> | undefined = {
      state: { seen: 2, hasRegisteredCurrentVersion: true },
      offset: 5,
    };
    const runner = createProcessorRunner({
      processor: echoExampleProcessor,
      deps: undefined,
      storage: { load: () => saved, save: (s) => void (saved = s) },
      stream,
    });

    // A re-delivered historical event (offset 4 <= snapshot 5) must be ignored.
    await runner.processEventBatch({ events: [input(4)], streamMaxOffset: 6 });
    expect(committed).toHaveLength(0);

    // A genuinely new event resumes from the persisted count.
    await runner.processEventBatch({ events: [input(6)], streamMaxOffset: 6 });
    expect(committed).toMatchObject([
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 3 } },
    ]);
    expect(saved?.offset).toBe(6);
  });

  it("does not double-process a re-delivered batch (idempotent)", async () => {
    const { stream, committed } = memoryStream();
    let saved: Snapshot<EchoExampleState> | undefined;
    const runner = createProcessorRunner({
      processor: echoExampleProcessor,
      deps: undefined,
      storage: { load: () => saved, save: (s) => void (saved = s) },
      stream,
    });

    await runner.processEventBatch({ events: [input(1)], streamMaxOffset: 1 });
    await runner.processEventBatch({ events: [input(1)], streamMaxOffset: 1 }); // exact re-delivery (e.g. after a reconnect)
    expect(committed).toMatchObject([
      { type: "events.iterate.com/stream/processor-registered" },
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 1 } },
    ]);
    expect(saved?.state.seen).toBe(1);
  });

  it("durable blockProcessorUntil: a crash before checkpoint reprocesses the event (at-least-once)", async () => {
    let attempts = 0;
    // Durable processor: the side effect is gated by blockProcessorUntil, so the
    // checkpoint must not advance until it succeeds.
    const durable = implementProcessor(echoExampleProcessorContract, () => ({
      afterAppend({ event, stream, blockProcessorUntil }) {
        if (event.type !== "events.iterate.com/echo-example/input-received") return;
        blockProcessorUntil(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient failure before checkpoint");
          stream.append({
            event: {
              type: "events.iterate.com/echo-example/output-echoed",
              payload: { seen: 0 },
            },
          });
        });
      },
    }));

    const { stream, committed } = memoryStream();
    let saved: Snapshot<EchoExampleState> | undefined;
    const storage = {
      load: () => saved,
      save: (s: Snapshot<EchoExampleState>) => void (saved = s),
    };

    // Runner 1: the blocker throws, so the batch rejects and nothing is checkpointed.
    const runner1 = createProcessorRunner({ processor: durable, deps: undefined, storage, stream });
    await expect(
      runner1.processEventBatch({ events: [input(1)], streamMaxOffset: 1 }),
    ).rejects.toThrow();
    expect(saved).toBeUndefined();
    expect(committed).toMatchObject([
      {
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: "processor-error:echo-example:1",
        payload: {
          message:
            "Processor echo-example side effects failed at offset 1: transient failure before checkpoint",
        },
      },
    ]);

    // Runner 2 (restart): the same event is re-delivered; this time the work succeeds.
    const runner2 = createProcessorRunner({ processor: durable, deps: undefined, storage, stream });
    await runner2.processEventBatch({ events: [input(1)], streamMaxOffset: 1 });
    expect(committed).toMatchObject([
      { type: "events.iterate.com/stream/error-occurred" },
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 0 } },
    ]);
    expect(saved?.offset).toBe(1);
    expect(attempts).toBe(2);
  });
});
