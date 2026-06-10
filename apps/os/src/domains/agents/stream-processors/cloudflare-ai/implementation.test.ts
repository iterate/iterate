// Regression coverage for crash-recovery semantics. LLM execution runs in the
// background, so `ingest` resolves before the provider call completes and
// assertions on appended events wait via `waitFor`. A redelivered
// agent/llm-request-requested must retry a request stuck in "started" (a
// previous incarnation died mid-request) and must skip one already
// "completed"; a "started" entry with no redelivery (the checkpoint advanced
// past the requested event before the crash) must be recovered by
// dangling-started reconciliation. Mirrors the OpenAI WebSocket processor's
// behavior.

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

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/cloudflare-ai/llm-request-completed"),
    );
    expect(runs).toEqual(["test-model"]);
    expect(eventTypes(appended)).toContain("events.iterate.com/cloudflare-ai/llm-request-started");
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

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/cloudflare-ai/llm-request-completed"),
    );
    expect(runs).toEqual(["test-model"]);
  });

  it("recovers a dangling started request on reconnect, with zero new domain events", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      // A previous incarnation checkpointed past the requested event (11) and
      // its started append (12), then died mid-request. This fresh instance's
      // executed set is empty, so nothing but reconciliation can retry it.
      snapshot: { offset: 12, state: stateWithRequest(11, "started") },
      // History holds the original requested event at offset === llmRequestId
      // and the agent's reduced phase still points at it (current request).
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 11 })],
    });

    // The host re-handshakes after the crash; the only thing the stream
    // delivers is its subscriber-connected presence fact. That alone must
    // recover the request — no user message or other domain event required.
    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 13 })],
      streamMaxOffset: 13,
    });

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    expect(runs).toEqual(["test-model"]);
    // The crash is recorded explicitly before the retry, so the stream
    // honestly shows "attempt died here, retried here".
    expect(eventTypes(appended)).toContain(
      "events.iterate.com/cloudflare-ai/llm-request-attempt-failed",
    );
    expect(eventTypes(appended)).toContain(
      "events.iterate.com/cloudflare-ai/llm-request-completed",
    );
    // The recovered request is still current, so agent output lands too.
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/output-added");
  });

  it("does not run dangling recovery on ordinary domain batches", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      snapshot: { offset: 12, state: stateWithRequest(11, "started") },
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 11 })],
    });

    // Recovery is connect-driven: a connected event is guaranteed on every
    // host incarnation, so unrelated domain traffic does not need to (and
    // must not) trigger speculative re-execution.
    await processor.ingest({
      events: [llmRequestCompletedEvent({ offset: 13, llmRequestId: 5 })],
      streamMaxOffset: 13,
    });

    expect(runs).toEqual([]);
    expect(appended).toEqual([]);
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
  readStreamEvents?: () => Promise<StreamEvent[]>;
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
    readStreamEvents: args.readStreamEvents ?? (async () => []),
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

function subscriberConnectedEvent(args: { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/stream/subscriber-connected",
    payload: {
      subscriptionKey: "agent-host:cloudflare-ai",
      direction: "outbound" as const,
      subscriber: { incarnationId: "fresh-incarnation" },
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function llmRequestCompletedEvent(args: { offset: number; llmRequestId: number }): StreamEvent {
  return {
    type: "events.iterate.com/cloudflare-ai/llm-request-completed",
    payload: {
      llmRequestId: args.llmRequestId,
      durationMs: 1,
      result: { status: "success" as const },
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition.");
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
