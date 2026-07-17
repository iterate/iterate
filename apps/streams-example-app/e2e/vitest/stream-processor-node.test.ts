// Node runtime over a REAL WebSocket subscription: hosts a class-based stream
// processor in-process against a running worker — the playground named by
// WORKER_URL (deployed, as in the preview CI lane) or the local `pnpm dev`
// server when WORKER_URL is unset. Runs unconditionally; an unreachable
// target fails loudly via ../vitest-global-setup.ts instead of skipping.
//
// The pre-itx-v4 streams implementation shipped an echo example processor; itx does
// not, so this suite defines an equivalent inline with the itx
// `defineProcessorContract` + `StreamProcessor` class — the SAME machinery the
// Durable-Object-side processor hosts run.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Stream } from "iterate/sdk";
import { e2eStreamPathLabel, toStreamWebSocketUrl } from "../helpers.ts";
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";
import { defineProcessorContract } from "~/domains/streams/processor-contracts.ts";
import { StreamProcessor } from "~/domains/streams/stream-processor.ts";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
} from "~/domains/streams/stream-processor-runner.ts";

const EchoExampleContract = defineProcessorContract({
  slug: "echo-example",
  version: "0.0.1",
  description: "Echoes every input-received event back as an output-echoed event.",
  stateSchema: z.object({ seen: z.number().int().nonnegative().default(0) }),
  events: {
    "events.iterate.com/echo-example/input-received": {
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/echo-example/output-echoed": {
      payloadSchema: z.looseObject({}),
    },
  },
  consumes: ["events.iterate.com/echo-example/input-received"],
  emits: ["events.iterate.com/echo-example/output-echoed"],
});

type EchoExampleContract = typeof EchoExampleContract;
type EchoExampleState = z.output<EchoExampleContract["stateSchema"]>;

class EchoExampleProcessor extends StreamProcessor<EchoExampleContract> {
  readonly contract = EchoExampleContract;

  protected override reduce(
    args: Parameters<StreamProcessor<EchoExampleContract>["reduce"]>[0],
  ): EchoExampleState {
    return { seen: args.state.seen + 1 };
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<EchoExampleContract>["processEvent"]>[0],
  ): undefined {
    const event = args.event;
    if (event === null) return;
    args.blockProcessorWhile(() =>
      args.append({
        type: "events.iterate.com/echo-example/output-echoed",
        payload: { echoedOffset: event.offset },
      }),
    );
  }
}

// In-process host: the node-side equivalent of the Durable-Object registry,
// boiled down to what one processor on one connection needs — a REAL
// StreamProcessorRunner whose durable progress lives in the caller's storage.
async function hostEcho(args: {
  stream: Stream;
  path: string;
  subscriptionKey: string;
  storage: {
    load: () => ProcessorProgress<EchoExampleState> | undefined;
    save: (progress: ProcessorProgress<EchoExampleState>) => void;
  };
}) {
  const processor = new EchoExampleProcessor({
    stream: args.stream,
    path: args.path,
    projectId: null,
  });
  const runner = new StreamProcessorRunner({
    processor,
    stream: args.stream,
    durability: {
      progress: {
        read: args.storage.load,
        commit: (progress) => args.storage.save(progress),
      },
    },
  });
  const opened = await runner.openDelivery();
  const handle = await args.stream.subscribe({
    subscriptionKey: args.subscriptionKey,
    replayAfterOffset: opened.checkpointOffset,
    // The contract is the delivery filter: only consumed types arrive.
    eventTypes: processor.contract.consumes,
    processEventBatch: opened.sink,
  });
  return { processor, runner, handle };
}

describe("node-hosted stream processor (e2e)", () => {
  it("hosts echo in-process over a plain subscription", async () => {
    const path = e2eStreamPathLabel("node-echo");
    using connection = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path }),
    });
    const stream = connection.stream as unknown as Stream;

    let saved: ProcessorProgress<EchoExampleState> | undefined;
    const { handle } = await hostEcho({
      stream,
      path,
      subscriptionKey: "node-echo",
      storage: { load: () => saved, save: (progress) => void (saved = progress) },
    });
    try {
      await stream.append({
        type: "events.iterate.com/echo-example/input-received",
        payload: { path },
      });

      // echo appends output-echoed back into the stream; poll for it.
      const startedAt = Date.now();
      let outputs: number[] = [];
      while (Date.now() - startedAt < 4_000) {
        const events = await stream.getEvents({});
        outputs = events
          .filter((e) => e.type === "events.iterate.com/echo-example/output-echoed")
          .map((e) => e.offset);
        if (outputs.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(outputs.length).toBeGreaterThan(0);
      // The echoed append becomes readable before the runner's progress
      // commit is guaranteed to have completed. Observe both independent
      // effects instead of racing the local durability callback.
      await waitUntil(() => saved?.reduction.state.seen === 1, 5_000);
      expect(saved?.reduction.state.seen).toBe(1);
    } finally {
      handle.unsubscribe();
    }
  });

  it("reconnects and resumes from its snapshot without reprocessing", async () => {
    const path = e2eStreamPathLabel("node-resume");
    let saved: ProcessorProgress<EchoExampleState> | undefined;
    const storage = {
      load: () => saved,
      save: (progress: ProcessorProgress<EchoExampleState>) => void (saved = progress),
    };

    // Session 1: process one input, then drop the connection + processor.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const stream = connection.stream as unknown as Stream;
      const { handle } = await hostEcho({
        stream,
        path,
        subscriptionKey: "resume",
        storage,
      });
      try {
        await stream.append({
          type: "events.iterate.com/echo-example/input-received",
          payload: { path },
        });
        await waitUntil(() => saved?.reduction.state.seen === 1, 5_000);
      } finally {
        handle.unsubscribe();
      }
    }
    const offsetAfterFirst = saved?.processing.acknowledgedThroughOffset ?? -1;
    expect(saved?.reduction.state.seen).toBe(1);

    // Session 2: fresh connection + fresh processor, SAME persisted snapshot.
    // It must resume (subscribe afterOffset = stored offset), not reprocess.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const stream = connection.stream as unknown as Stream;
      const { handle } = await hostEcho({
        stream,
        path,
        subscriptionKey: "resume",
        storage,
      });
      try {
        await stream.append({
          type: "events.iterate.com/echo-example/input-received",
          payload: { path },
        });
        await waitUntil(() => (saved?.reduction.state.seen ?? 0) === 2, 5_000);
      } finally {
        handle.unsubscribe();
      }
    }
    expect(saved?.reduction.state.seen).toBe(2); // resumed from 1; second input counted exactly once
    expect(saved?.processing.acknowledgedThroughOffset ?? -1).toBeGreaterThan(offsetAfterFirst);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitUntil timed out");
}
