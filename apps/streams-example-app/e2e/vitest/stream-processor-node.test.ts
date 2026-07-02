// Node runtime over a REAL WebSocket subscription: hosts a class-based stream
// processor in-process against a running worker. Gated like the other e2e —
// set STREAM_STAGING_E2E=true with `pnpm dev` running. Typecheck-verified always.
//
// The legacy engine shipped an echo example processor; the next engine does
// not, so this suite defines an equivalent inline with the next engine's
// `defineProcessorContract` + `StreamProcessor` class — the SAME machinery the
// Durable-Object-side processor hosts run.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { e2eStreamPathLabel, toStreamWebSocketUrl } from "../helpers.ts";
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";
import {
  defineProcessorContract,
  StreamProcessor,
  type StreamProcessorSnapshot,
} from "~/domains/streams/stream-processor.ts";
import type { Stream } from "~/types.ts";

const e2eIt = process.env.STREAM_STAGING_E2E === "true" ? it : it.skip;

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
    args.blockProcessorWhile(() =>
      args.append({
        type: "events.iterate.com/echo-example/output-echoed",
        payload: { echoedOffset: args.event.offset },
      }),
    );
  }
}

// In-process host: the node-side equivalent of the Durable-Object processor
// host, boiled down to what one processor on one connection needs.
async function hostEcho(args: {
  stream: Stream;
  subscriptionKey: string;
  storage: {
    load: () => StreamProcessorSnapshot<EchoExampleState> | undefined;
    save: (snapshot: StreamProcessorSnapshot<EchoExampleState>) => void;
  };
}) {
  const processor = new EchoExampleProcessor({
    stream: args.stream,
    readState: args.storage.load,
    writeState: args.storage.save,
  });
  const snapshot = await processor.snapshot();
  const handle = await args.stream.subscribe({
    subscriptionKey: args.subscriptionKey,
    replayAfterOffset: snapshot.offset,
    // The contract is the delivery filter: only consumed types arrive.
    eventTypes: processor.contract.consumes,
    processEventBatch: (batch) => processor.ingest(batch),
  });
  return { processor, handle };
}

describe("node-hosted stream processor (e2e)", () => {
  e2eIt("hosts echo in-process over a plain subscription", async () => {
    const path = e2eStreamPathLabel("node-echo");
    using connection = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path }),
    });
    const stream = connection.stream as unknown as Stream;

    let saved: StreamProcessorSnapshot<EchoExampleState> | undefined;
    const { handle } = await hostEcho({
      stream,
      subscriptionKey: "node-echo",
      storage: { load: () => saved, save: (snapshot) => void (saved = snapshot) },
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
      expect(saved?.state.seen).toBe(1);
    } finally {
      handle.unsubscribe();
    }
  });

  e2eIt("reconnects and resumes from its snapshot without reprocessing", async () => {
    const path = e2eStreamPathLabel("node-resume");
    let saved: StreamProcessorSnapshot<EchoExampleState> | undefined;
    const storage = {
      load: () => saved,
      save: (snapshot: StreamProcessorSnapshot<EchoExampleState>) => void (saved = snapshot),
    };

    // Session 1: process one input, then drop the connection + processor.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const stream = connection.stream as unknown as Stream;
      const { handle } = await hostEcho({
        stream,
        subscriptionKey: "resume",
        storage,
      });
      try {
        await stream.append({
          type: "events.iterate.com/echo-example/input-received",
          payload: { path },
        });
        await waitUntil(() => saved?.state.seen === 1, 5_000);
      } finally {
        handle.unsubscribe();
      }
    }
    const offsetAfterFirst = saved?.offset ?? -1;
    expect(saved?.state.seen).toBe(1);

    // Session 2: fresh connection + fresh processor, SAME persisted snapshot.
    // It must resume (subscribe afterOffset = stored offset), not reprocess.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const stream = connection.stream as unknown as Stream;
      const { handle } = await hostEcho({
        stream,
        subscriptionKey: "resume",
        storage,
      });
      try {
        await stream.append({
          type: "events.iterate.com/echo-example/input-received",
          payload: { path },
        });
        await waitUntil(() => (saved?.state.seen ?? 0) === 2, 5_000);
      } finally {
        handle.unsubscribe();
      }
    }
    expect(saved?.state.seen).toBe(2); // resumed from 1; second input counted exactly once
    expect(saved?.offset ?? -1).toBeGreaterThan(offsetAfterFirst);
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
