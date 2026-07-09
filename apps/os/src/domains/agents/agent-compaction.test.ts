// Context-compaction specs: the reducer fold, the usage-based trigger, the
// summarization round-trip, and provider continuation across a compaction
// boundary. Same in-memory harness as agent-processors.test.ts.

import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  AgentProcessor,
  buildAgentLlmRequestBody,
  reduceAgentEvents,
} from "./agent-processor-implementation.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { buildCompactionRequestMessages } from "./agent-compaction.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import { OpenAiWsProcessor } from "./openai-ws-processor-implementation.ts";
import {
  MemoryStream,
  deliverNewEvents,
  fakeResponsesWebSocket,
  type FakeResponsesWebSocket,
  type ProcessorLike,
} from "./test-helpers.ts";

describe("agent context compaction", () => {
  it("folds compaction-completed: drops summarized history, prepends the checkpoint", async () => {
    const stream = new MemoryStream();
    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "Please compile the ACME report",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      }, // offset 1
      {
        type: "events.iterate.com/agent/output-added",
        payload: { content: "On it." },
      }, // offset 2
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "second question",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      }, // offset 3
      {
        type: "events.iterate.com/agent/compaction-requested",
        payload: { reason: "threshold", firstKeptOffset: 3, tokensBefore: 123_456 },
      },
      {
        type: "events.iterate.com/agent/compaction-completed",
        payload: {
          summary: "## Goal\nCompile the ACME report",
          firstKeptOffset: 3,
          tokensBefore: 123_456,
        },
      },
    );

    const state = reduceAgentEvents(stream.events);
    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toMatchObject({
      role: "user",
      summary: true,
      content: expect.stringContaining("[CONTEXT CHECKPOINT]"),
    });
    expect(state.history[0]!.content).toContain("## Goal\nCompile the ACME report");
    expect(state.history[0]!.content).toContain("do NOT repeat");
    expect(state.history[1]).toMatchObject({ role: "user", content: "second question", offset: 3 });
    expect(state.pendingCompaction).toBeNull();
    expect(state.lastUsage).toBeNull();

    // The provider-facing body carries the checkpoint but none of the
    // internal bookkeeping fields.
    const body = buildAgentLlmRequestBody({ events: stream.events, llmRequestId: 99 });
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(body.messages[1]!.content).toContain("[CONTEXT CHECKPOINT]");
    expect(body.messages.some((message) => "offset" in message || "summary" in message)).toBe(
      false,
    );
    expect(body).toMatchObject({ purpose: "chat", compactionCount: 1 });
  });

  it("records typed usage from llm-request-completed and shrugs off malformed usage", async () => {
    const stream = new MemoryStream();
    await stream.append(...llmTurn({ requestId: "llm-request:gen-0" }), {
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 5,
        llmRequestId: 2,
        provider: "cloudflare-ai",
        result: {
          status: "success",
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      },
    });
    expect(reduceAgentEvents(stream.events)).toMatchObject({
      lastUsage: { llmRequestId: 2, totalTokens: 120 },
    });

    // A usage shape nobody recognizes must not poison the completion event:
    // the request still settles, lastUsage just keeps its previous value.
    await stream.append(...llmTurn({ requestId: "llm-request:gen-1" }), {
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 5,
        llmRequestId: 5,
        provider: "cloudflare-ai",
        result: { status: "success", usage: "wat" },
      },
    });
    expect(reduceAgentEvents(stream.events)).toMatchObject({
      currentRequest: null,
      requestGeneration: 2,
      lastUsage: { llmRequestId: 2, totalTokens: 120 },
    });
  });

  it("requests compaction instead of a chat request when over the context budget", async () => {
    const stream = new MemoryStream();
    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    const state = AgentProcessorContract.stateSchema.parse({
      // ~15k estimated tokens per entry; the 20k keep-window covers only the
      // newest entry, so the cut lands at its offset (9).
      history: [
        { role: "user", content: "a".repeat(60_000), offset: 5 },
        { role: "assistant", content: "b".repeat(60_000), offset: 7 },
        { role: "user", content: "c".repeat(60_000), offset: 9 },
      ],
      lastUsage: { llmRequestId: 10, totalTokens: 250_000 }, // kimi window 262_144, reserve 24_000
      pendingTriggerOffset: 11,
      pendingTriggerSource: "user",
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({ stream, readState: async () => ({ offset: 1, state }) });

    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    const compactionRequested = eventsOfType(
      stream,
      "events.iterate.com/agent/compaction-requested",
    );
    expect(compactionRequested).toHaveLength(1);
    expect(compactionRequested[0]!.payload).toMatchObject({
      reason: "threshold",
      firstKeptOffset: 9,
      tokensBefore: 250_000,
    });
    expect(eventsOfType(stream, "events.iterate.com/agent/llm-request-scheduled")).toEqual([]);
  });

  it("does not re-request compaction for the same usage measurement (thrash guard)", async () => {
    const stream = new MemoryStream();
    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    const state = AgentProcessorContract.stateSchema.parse({
      history: [
        { role: "user", content: "a".repeat(60_000), offset: 5 },
        { role: "assistant", content: "b".repeat(60_000), offset: 7 },
        { role: "user", content: "c".repeat(60_000), offset: 9 },
      ],
      lastUsage: { llmRequestId: 10, totalTokens: 250_000 },
      // A compaction was already attempted for measurement 10 (it failed or
      // was cancelled): fall through to a normal chat request.
      lastCompactionAttempt: { usageLlmRequestId: 10 },
      pendingTriggerOffset: 11,
      pendingTriggerSource: "user",
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({ stream, readState: async () => ({ offset: 1, state }) });

    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    expect(eventsOfType(stream, "events.iterate.com/agent/compaction-requested")).toEqual([]);
    const scheduled = eventsOfType(stream, "events.iterate.com/agent/llm-request-scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({ requestId: "llm-request:gen-0" });
    expect(scheduled[0]!.payload).not.toHaveProperty("purpose");
  });

  it("schedules the summarization request for a pending compaction, keeping the chat trigger pending", async () => {
    const stream = new MemoryStream();
    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    const state = AgentProcessorContract.stateSchema.parse({
      history: [{ role: "user", content: "hello", offset: 5 }],
      pendingCompaction: { requestedOffset: 12, firstKeptOffset: 9, tokensBefore: 250_000 },
      pendingTriggerOffset: 11,
      pendingTriggerSource: "user",
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({ stream, readState: async () => ({ offset: 1, state }) });

    await stream.append({ type: "events.iterate.com/stream/woken", payload: {} });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    const scheduled = eventsOfType(stream, "events.iterate.com/agent/llm-request-scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({
      debounceMs: 0,
      purpose: "compaction",
      requestId: "llm-request:compaction-12",
    });
    // The chat trigger survives the compaction request: it schedules the real
    // turn once the compaction settles.
    expect(agent.state).toMatchObject({ pendingTriggerOffset: 11, pendingTriggerSource: "user" });
  });

  it("journals compaction-failed on summarizer failure and falls through to a normal request", async () => {
    const stream = new MemoryStream();
    // The compaction's own scheduled event is already on the stream (offset 1,
    // behind the checkpoint): the settle that runs between the failure
    // completion and the compaction-failed fold re-derives the same append
    // and dedups into it instead of re-dialing the summarizer.
    await stream.append({
      type: "events.iterate.com/agent/llm-request-scheduled",
      idempotencyKey: "agent/llm-request-scheduled@compaction:12",
      payload: {
        debounceMs: 0,
        model: "@cf/moonshotai/kimi-k2.7-code",
        provider: "cloudflare-ai",
        purpose: "compaction",
        requestId: "llm-request:compaction-12",
      },
    });
    const state = AgentProcessorContract.stateSchema.parse({
      history: [{ role: "user", content: "hello", offset: 5 }],
      currentRequest: { phase: "requested", llmRequestId: 13, purpose: "compaction" },
      pendingCompaction: { requestedOffset: 12, firstKeptOffset: 9, tokensBefore: 250_000 },
      lastUsage: { llmRequestId: 10, totalTokens: 250_000 },
      lastCompactionAttempt: { usageLlmRequestId: 10 },
      pendingTriggerOffset: 11,
      pendingTriggerSource: "user",
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({ stream, readState: async () => ({ offset: 1, state }) });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestId: 13,
        provider: "cloudflare-ai",
        result: { status: "failure", error: { message: "summarizer exploded" } },
      },
    });
    await deliverNewEvents({ processor: agent, stream, cursors });
    await deliverNewEvents({ processor: agent, stream, cursors });

    const failed = eventsOfType(stream, "events.iterate.com/agent/compaction-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      error: { message: "summarizer exploded" },
      requestedOffset: 12,
    });
    // History untouched, no model-visible error input, and the chat request
    // proceeds (the attempt guard stops a compaction retry loop).
    expect(agent.state.history).toHaveLength(1);
    expect(eventsOfType(stream, "events.iterate.com/agent/input-added")).toEqual([]);
    const scheduled = eventsOfType(stream, "events.iterate.com/agent/llm-request-scheduled");
    expect(scheduled).toHaveLength(2); // the seeded compaction one + the chat retry
    expect(scheduled[1]!.payload).toMatchObject({ requestId: "llm-request:gen-1" });
    expect(scheduled[1]!.payload).not.toHaveProperty("purpose");
  });

  it("rolls a previous checkpoint into the next summarization request", () => {
    const messages = buildCompactionRequestMessages({
      history: [
        { role: "user", content: "[CONTEXT CHECKPOINT] previous summary here", summary: true },
        { role: "user", content: "Your script returned:\n" + "x".repeat(5_000), offset: 4 },
        { role: "assistant", content: "async (itx) => itx.chat.sendMessage('hi')", offset: 5 },
        { role: "user", content: "kept verbatim", offset: 9 },
      ],
      firstKeptOffset: 9,
    });
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Side effects already performed"),
    });
    const request = messages[1]!.content;
    expect(request).toContain("<previous-checkpoint>\n[CONTEXT CHECKPOINT] previous summary here");
    // Script results are clipped; script code rides verbatim; the keep-window
    // entry stays out of the transcript.
    expect(request).toContain("[script result clipped for compaction: 5022 chars total]");
    expect(request).toContain("[Assistant]: async (itx) => itx.chat.sendMessage('hi')");
    expect(request).not.toContain("kept verbatim");
  });

  it("compacts then continues: summarization call, checkpoint fold, compacted next request (cloudflare-ai)", async () => {
    const stream = new MemoryStream();
    const aiCalls: { messages: { role: string; content: string }[] }[] = [];
    const agent = new AgentProcessor({ stream });
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run(_model, body) {
          const call = body as { messages: { role: string; content: string }[] };
          aiCalls.push(call);
          if (call.messages[0]!.content.includes("context-compaction assistant")) {
            return { response: CHECKPOINT_TEXT };
          }
          // Chat turns report usage just over the kimi budget
          // (window 262_144 − reserve 24_000 = 238_144).
          return {
            response: aiCalls.length === 1 ? "Status noted." : "Email sent.",
            usage: { prompt_tokens: 249_000, completion_tokens: 1_000, total_tokens: 250_000 },
          };
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const processors = [agent, cloudflareAi];

    // Seed a conversation whose bloat is one oversized script result.
    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "Please compile the quarterly report for ACME corp.",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "Your script returned:\n" + "x".repeat(100_000),
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "Summarize status so far.",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    );
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: (events) =>
        events.some((event) => event.type === "events.iterate.com/agent/llm-request-completed"),
    });

    // The next user turn settles over budget: compaction runs first, then the
    // chat request answers with compacted history.
    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "Now email the report.",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: () => aiCalls.length >= 3 && aiCalls.at(-1)!.messages.length > 0,
    });
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: (events) =>
        events.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length >= 3,
    });

    expect(eventsOfType(stream, "events.iterate.com/agent/compaction-requested")).toHaveLength(1);
    expect(eventsOfType(stream, "events.iterate.com/agent/compaction-completed")).toHaveLength(1);

    // Call 2 is the summarization request: compaction system prompt, labeled
    // transcript, script result clipped (the 100k-char result never rides).
    const compactionCall = aiCalls[1]!;
    expect(compactionCall.messages[0]!.content).toContain("context-compaction assistant");
    const transcript = compactionCall.messages[1]!.content;
    expect(transcript).toContain("<transcript>");
    expect(transcript).toContain("[User]: Please compile the quarterly report for ACME corp.");
    expect(transcript).toContain("[script result clipped for compaction");
    expect(transcript.length).toBeLessThan(15_000);

    // Call 3 is the post-compaction chat request: checkpoint + kept-verbatim
    // tail, without the summarized bulk.
    const compactedCall = aiCalls[2]!;
    const contents = compactedCall.messages.map((message) => message.content);
    expect(compactedCall.messages[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("[CONTEXT CHECKPOINT]"),
    });
    expect(compactedCall.messages[1]!.content).toContain("Slack message ts 12345.678");
    expect(contents).toContain("Summarize status so far.");
    expect(contents).toContain("Now email the report.");
    expect(contents.some((content) => content.includes("x".repeat(10_000)))).toBe(false);

    // The checkpoint never runs as a script, even if it contained code.
    expect(
      eventsOfType(stream, "events.iterate.com/capability-host/script-execution-requested"),
    ).toEqual([]);
  });

  it("does a full resend (no previous_response_id) on the first openai-ws request after a compaction", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const sockets: FakeResponsesWebSocket[] = [];
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        let calls = 0;
        const socket = fakeResponsesWebSocket(() => {
          calls += 1;
          if (calls === 1) {
            return [
              { type: "response.output_text.delta", delta: "First answer." },
              {
                type: "response.completed",
                response: { id: "resp_1", usage: { total_tokens: 250_000 } },
              },
            ];
          }
          if (calls === 2) {
            return [
              { type: "response.output_text.delta", delta: CHECKPOINT_TEXT },
              { type: "response.completed", response: { id: "resp_2" } },
            ];
          }
          if (calls === 3) {
            return [
              { type: "response.output_text.delta", delta: "Second answer." },
              { type: "response.completed", response: { id: "resp_3" } },
            ];
          }
          return [
            { type: "response.output_text.delta", delta: "You're welcome." },
            { type: "response.completed", response: { id: "resp_4" } },
          ];
        });
        sockets.push(socket);
        return socket;
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const processors = [agent, openAiWs];

    await stream.append(
      {
        type: "events.iterate.com/agent/llm-provider-selected",
        payload: { model: "gpt-5.5", provider: "openai-ws" },
      },
      {
        type: "events.iterate.com/agent/input-added",
        // ~25k estimated tokens: bigger than the keep-window, so it is the
        // span the compaction summarizes. Usage 250k > 272k − 24k reserve.
        payload: {
          content: "a".repeat(100_000),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    );
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: (events) =>
        events.some((event) => event.type === "events.iterate.com/agent/llm-request-completed"),
    });

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: { content: "What next?", llmRequestPolicy: { behaviour: "after-current-request" } },
    });
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: (events) =>
        events.some((event) => event.type === "events.iterate.com/agent/compaction-completed") &&
        events.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length >= 3,
    });

    // One more turn proves continuation resumes AFTER the post-compaction
    // full resend (its response id was stored with the new boundary count).
    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: { content: "thanks!", llmRequestPolicy: { behaviour: "after-current-request" } },
    });
    await pumpUntil({
      stream,
      processors,
      cursors,
      predicate: (events) =>
        events.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length >= 4,
    });

    expect(sockets).toHaveLength(1);
    const sent = sockets[0]!.sent as {
      instructions: string;
      input: { role?: string; content: string }[];
      previous_response_id?: string;
    }[];
    expect(sent).toHaveLength(4);
    // 1: first chat request — nothing to continue from.
    expect(sent[0]).not.toHaveProperty("previous_response_id");
    // 2: the compaction request is a separate one-shot conversation.
    expect(sent[1]).not.toHaveProperty("previous_response_id");
    expect(sent[1]!.instructions).toContain("context-compaction assistant");
    expect(sent[1]!.input[0]!.content).toContain("<transcript>");
    // 3: first chat request after the boundary — full resend of the compacted
    // history (checkpoint + kept tail), no stale continuation id.
    expect(sent[2]).not.toHaveProperty("previous_response_id");
    const resentContents = sent[2]!.input.map((message) => message.content);
    expect(resentContents.some((content) => content.includes("[CONTEXT CHECKPOINT]"))).toBe(true);
    expect(resentContents).toContain("First answer.");
    expect(resentContents).toContain("What next?");
    expect(resentContents.some((content) => content.includes("a".repeat(10_000)))).toBe(false);
    // 4: continuation resumes from the post-compaction response.
    expect(sent[3]).toMatchObject({ previous_response_id: "resp_3" });
    expect(sent[3]!.input.map((message) => message.content)).toEqual(["thanks!"]);
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const CHECKPOINT_TEXT = [
  "## Goal",
  "Compile and send the ACME quarterly report.",
  "## Constraints & preferences",
  "## Progress",
  "Report data fetched.",
  "## Key decisions",
  "## All user asks",
  "Compile the quarterly report; summarize status.",
  "## Entities & handles",
  "Slack message ts 12345.678",
  "## Side effects already performed — do not repeat",
  "Posted a status update to Slack.",
  "## Current work",
  "Emailing the report next.",
].join("\n");

function eventsOfType(stream: MemoryStream, type: string): StreamEvent[] {
  return stream.events.filter((event) => event.type === type);
}

/** A scheduled+requested pair so a completion event has a matching
 * currentRequest to settle. Offsets are consecutive from the stream tail. */
function llmTurn(input: { requestId: string }) {
  return [
    {
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: {
        debounceMs: 0,
        model: "@cf/moonshotai/kimi-k2.7-code",
        provider: "cloudflare-ai",
        requestId: input.requestId,
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      payload: {
        model: "@cf/moonshotai/kimi-k2.7-code",
        provider: "cloudflare-ai",
        requestId: input.requestId,
      },
    },
  ] as const;
}

/** Pumps event delivery to every processor until the predicate holds — the
 * in-memory stand-in for production's subscription redelivery loop. */
async function pumpUntil(input: {
  stream: MemoryStream;
  processors: ProcessorLike[];
  cursors: Map<object, number>;
  predicate: (events: StreamEvent[]) => boolean;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs || 5_000);
  while (Date.now() < deadline) {
    for (const processor of input.processors) {
      await deliverNewEvents({ processor, stream: input.stream, cursors: input.cursors });
    }
    if (input.predicate(input.stream.events)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `pumpUntil timed out. events so far:\n${input.stream.events
      .map((event) => `${event.offset} ${event.type}`)
      .join("\n")}`,
  );
}
