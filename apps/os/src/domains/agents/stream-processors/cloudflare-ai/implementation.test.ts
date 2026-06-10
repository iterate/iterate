// Regression coverage for crash-replay semantics: a redelivered
// agent/llm-request-requested must retry a request stuck in "started" (a
// previous incarnation died mid-request) and must skip one already
// "completed". Mirrors the OpenAI WebSocket processor's behavior.

import { describe, expect, it } from "vitest";
import { getInitialProcessorState } from "@iterate-com/streams/shared/stream-processors";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import type {
  StreamProcessorIterateContext,
  StreamProcessorSnapshot,
} from "@iterate-com/streams/stream-processor";
import { CloudflareAiProcessorContract, type CloudflareAiState } from "./contract.ts";
import { CloudflareAiProcessor } from "./implementation.ts";

describe("CloudflareAiProcessor", () => {
  it("executes a fresh agent LLM request", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({ stream, runs });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });

    expect(runs).toEqual(["test-model"]);
    expect(eventTypes(appended)).toContain("events.iterate.com/cloudflare-ai/llm-request-started");
    expect(eventTypes(appended)).toContain(
      "events.iterate.com/cloudflare-ai/llm-request-completed",
    );
  });

  it("retries a request a previous incarnation left in started", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      // Crash window: started was reduced, completion never happened. The
      // checkpoint sits before the requested event so it redelivers.
      snapshot: { offset: 10, state: stateWithRequest(11, "started") },
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });

    expect(runs).toEqual(["test-model"]);
    expect(eventTypes(appended)).toContain(
      "events.iterate.com/cloudflare-ai/llm-request-completed",
    );
  });

  it("skips a request that already completed", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      snapshot: { offset: 10, state: stateWithRequest(11, "completed") },
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });

    expect(runs).toEqual([]);
    expect(appended).toEqual([]);
  });
});

function stateWithRequest(
  llmRequestId: number,
  status: "started" | "completed",
): CloudflareAiState {
  return {
    ...getInitialProcessorState(CloudflareAiProcessorContract),
    requests: { [String(llmRequestId)]: { status } },
  };
}

function newProcessor(args: {
  stream: StreamProcessorIterateContext["stream"];
  runs: string[];
  snapshot?: StreamProcessorSnapshot<CloudflareAiState>;
}) {
  return new CloudflareAiProcessor({
    iterateContext: { stream: args.stream },
    readState: () => args.snapshot,
    ai: {
      run: async (model: string) => {
        args.runs.push(model);
        return { response: "ok" };
      },
    },
    // The agent's stream history; empty means the output-added append is
    // skipped as stale, which is fine — completion events still land.
    readStreamEvents: async () => [],
  });
}

function llmRequestRequestedEvent(args: { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: {
      model: "test-model",
      body: { messages: [{ role: "user" as const, content: "hi" }] },
      runOpts: {},
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryStream() {
  let nextOffset = 100;
  const appended: StreamEventInput[] = [];
  const stream: StreamProcessorIterateContext["stream"] = {
    append: (appendArgs) => {
      appended.push(appendArgs.event as StreamEventInput);
      const committed: StreamEvent = {
        ...(appendArgs.event as StreamEventInput),
        offset: nextOffset++,
        createdAt: new Date(0).toISOString(),
      };
      return committed;
    },
    appendBatch: (batchArgs) =>
      (batchArgs.events as StreamEventInput[]).map((input) => {
        appended.push(input);
        const committed: StreamEvent = {
          ...input,
          offset: nextOffset++,
          createdAt: new Date(0).toISOString(),
        };
        return committed;
      }),
  };
  return { stream, appended };
}

function eventTypes(events: StreamEventInput[]) {
  return events.map((event) => event.type);
}
