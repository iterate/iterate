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

  it("rebuilds the chat request from history up to the request's offset", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const bodies: unknown[] = [];
    const processor = newProcessor({
      stream,
      runs,
      bodies,
      // Request-by-reference: the requested event carries no body, so what
      // the model sees is exactly the reduction of committed history up to
      // the request's own offset — rows that landed after it are excluded.
      readStreamEvents: async () => [
        inputAddedEvent({ offset: 2, content: "hello" }),
        llmRequestRequestedEvent({ offset: 11 }),
        inputAddedEvent({ offset: 15, content: "landed after the request" }),
      ],
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/cloudflare-ai/llm-request-completed"),
    );
    expect(bodies).toEqual([
      {
        messages: [
          { role: "system", content: "You are a helpful assistant. You can trust your user." },
          { role: "user", content: "hello" },
        ],
        stream: true,
      },
    ]);
  });

  it("appends every streamed chunk and reassembles the assistant text", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      aiResult: () =>
        sseStream([
          `data: ${JSON.stringify({ response: "Hel" })}`,
          `data: ${JSON.stringify({ response: "lo" })}`,
          `data: ${JSON.stringify({ response: "", usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
          "data: [DONE]",
        ]),
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 11 })],
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    const chunkEvents = appended.filter(
      (event) => event.type === "events.iterate.com/cloudflare-ai/llm-response-chunk",
    );
    expect(chunkEvents).toHaveLength(3);
    expect(chunkEvents.map((event) => (event.payload as { sequence: number }).sequence)).toEqual([
      0, 1, 2,
    ]);
    const outputAdded = appended.find(
      (event) => event.type === "events.iterate.com/agent/output-added",
    );
    expect(outputAdded?.payload).toMatchObject({ content: "Hello", llmRequestId: 11 });
    const completed = appended.find(
      (event) => event.type === "events.iterate.com/agent/llm-request-completed",
    );
    expect(completed?.payload).toMatchObject({
      result: { status: "success", usage: { prompt_tokens: 5, completion_tokens: 2 } },
    });
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

  it("recovers a dangling request exactly once when one batch carries several connect facts", async () => {
    const { stream, appended } = memoryStream();
    const runs: string[] = [];
    const processor = newProcessor({
      stream,
      runs,
      snapshot: { offset: 12, state: stateWithRequest(11, "started") },
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 11 })],
    });

    // An agent host re-handshake appends one connected event per co-hosted
    // processor subscription, so a single delivered batch routinely carries
    // several. Their blocking reconciles run concurrently — the dangling
    // request must still be claimed by exactly one of them.
    await processor.ingest({
      events: [subscriberConnectedEvent({ offset: 13 }), subscriberConnectedEvent({ offset: 14 })],
      streamMaxOffset: 14,
    });

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    expect(runs).toEqual(["test-model"]);
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
  bodies?: unknown[];
  snapshot?: StreamProcessorSnapshot<CloudflareAiState>;
  readStreamEvents?: () => Promise<StreamEvent[]>;
  aiResult?: () => unknown;
}) {
  return new CloudflareAiProcessor({
    iterateContext: { stream: args.stream },
    readState: () => args.snapshot,
    ai: {
      run: async (model: string, body: unknown) => {
        args.runs.push(model);
        args.bodies?.push(body);
        return args.aiResult?.() ?? { response: "ok" };
      },
    },
    // The agent's stream history; empty means the output-added append is
    // skipped as stale, which is fine — completion events still land.
    readStreamEvents: args.readStreamEvents ?? (async () => []),
  });
}

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  });
}

function llmRequestRequestedEvent(args: { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "test-model", runOpts: {} },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function inputAddedEvent(args: { offset: number; content: string }): StreamEvent {
  return {
    type: "events.iterate.com/agent/input-added",
    payload: { content: args.content, llmRequestPolicy: { behaviour: "dont-trigger-request" } },
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
