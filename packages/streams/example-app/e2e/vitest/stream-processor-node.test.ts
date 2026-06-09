// Node runtime over a REAL WebSocket subscription: hosts a stream processor
// in-process against a running worker. Gated like the
// other e2e — set STREAM_STAGING_E2E=true with `pnpm dev`
// running. Typecheck-verified always.

import { describe, expect, it } from "vitest";
import { withStreamConnectionFromNode } from "../../../src/node/connect.ts";
import { createStreamSubscription } from "../../../src/subscription.ts";
import { createProcessorRunner, type Snapshot } from "../../../src/processor-runner.ts";
// The SAME processor the DO (outbound) and the browser tab (inbound) run.
import { echoExampleProcessor } from "../../../src/processors/examples/echo/implementation.ts";
import type { EchoExampleState } from "../../../src/processors/examples/echo/contract.ts";
import { e2eStreamPathLabel, toStreamWebSocketUrl } from "../helpers.ts";

const e2eIt = process.env.STREAM_STAGING_E2E === "true" ? it : it.skip;

describe("node-hosted stream processor (e2e)", () => {
  e2eIt("hosts echo in-process over an inbound subscription", async () => {
    const path = e2eStreamPathLabel("node-echo");
    using connection = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path }),
    });

    let saved: Snapshot<EchoExampleState> | undefined;
    const processorRunner = createProcessorRunner({
      processor: echoExampleProcessor,
      deps: undefined,
      storage: { load: () => saved, save: (snapshot) => void (saved = snapshot) },
      stream: connection.stream,
    });
    let handle: { unsubscribe(): void } | undefined;
    await using subscription = createStreamSubscription({
      subscriptionKey: "node-echo",
      onDispose: () => handle?.unsubscribe(),
    });
    handle = await connection.stream.subscribe({
      subscriptionKey: "node-echo",
      replayAfterOffset: (await processorRunner.snapshot())?.offset ?? 0,
      processEventBatch: subscription.processEventBatch,
    });
    await using _processing = processorRunner.run({ subscription });

    await connection.stream.append({
      event: { type: "events.iterate.com/echo-example/input-received", payload: { path } },
    });

    // echo appends output-echoed back into the stream; poll for it.
    const startedAt = Date.now();
    let outputs: number[] = [];
    while (Date.now() - startedAt < 4_000) {
      const events = await connection.stream.getEvents({});
      outputs = events
        .filter((e) => e.type === "events.iterate.com/echo-example/output-echoed")
        .map((e) => e.offset);
      if (outputs.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(outputs.length).toBeGreaterThan(0);
    expect(saved?.state.seen).toBe(1);
  });

  e2eIt("reconnects and resumes from its snapshot without reprocessing", async () => {
    const path = e2eStreamPathLabel("node-resume");
    let saved: Snapshot<EchoExampleState> | undefined;
    const storage = {
      load: () => saved,
      save: (s: Snapshot<EchoExampleState>) => void (saved = s),
    };

    // Session 1: process one input, then drop the connection + runner.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const processorRunner = createProcessorRunner({
        processor: echoExampleProcessor,
        deps: undefined,
        storage,
        stream: connection.stream,
      });
      let handle: { unsubscribe(): void } | undefined;
      await using subscription = createStreamSubscription({
        subscriptionKey: "resume",
        onDispose: () => handle?.unsubscribe(),
      });
      handle = await connection.stream.subscribe({
        subscriptionKey: "resume",
        replayAfterOffset: (await processorRunner.snapshot())?.offset ?? 0,
        processEventBatch: subscription.processEventBatch,
      });
      await using _processing = processorRunner.run({ subscription });
      await connection.stream.append({
        event: { type: "events.iterate.com/echo-example/input-received", payload: { path } },
      });
      await waitUntil(() => saved?.state.seen === 1, 5_000);
    }
    const offsetAfterFirst = saved?.offset ?? -1;
    expect(saved?.state.seen).toBe(1);

    // Session 2: fresh connection + fresh runner, SAME persisted snapshot. It must
    // resume (subscribe afterOffset = stored offset), not reprocess the first input.
    {
      using connection = withStreamConnectionFromNode({
        url: toStreamWebSocketUrl({ path }),
      });
      const processorRunner = createProcessorRunner({
        processor: echoExampleProcessor,
        deps: undefined,
        storage,
        stream: connection.stream,
      });
      let handle: { unsubscribe(): void } | undefined;
      await using subscription = createStreamSubscription({
        subscriptionKey: "resume",
        onDispose: () => handle?.unsubscribe(),
      });
      handle = await connection.stream.subscribe({
        subscriptionKey: "resume",
        replayAfterOffset: (await processorRunner.snapshot())?.offset ?? 0,
        processEventBatch: subscription.processEventBatch,
      });
      await using _processing = processorRunner.run({ subscription });
      await connection.stream.append({
        event: { type: "events.iterate.com/echo-example/input-received", payload: { path } },
      });
      await waitUntil(() => (saved?.state.seen ?? 0) === 2, 5_000);
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
