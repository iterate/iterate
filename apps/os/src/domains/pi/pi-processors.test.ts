import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import {
  PiProcessorContract,
  type PiAssistantMessage,
  type PiToolCall,
} from "./pi-processor-contract.ts";
import {
  PiProcessor,
  buildPiLlmRequest,
  reducePiEvents,
  type PiLlmRequest,
  type PiToolDep,
} from "./pi-processor-implementation.ts";

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const appended = inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
    return appended;
  }

  at(): Stream {
    return this;
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(): Promise<StreamEvent[]> {
    return [...this.events];
  }

  async waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      for (const event of this.events) {
        if (input.afterOffset !== undefined && event.offset <= input.afterOffset) continue;
        if (input.eventTypes !== undefined && !input.eventTypes.includes(event.type)) continue;
        if (input.predicate !== undefined && !(await input.predicate(event))) continue;
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for event");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

/**
 * Manual delivery pump: feeds new stream events to the processor (the role the
 * real subscription host plays) until `until` holds, letting background side
 * effects append and feed back through the fold.
 */
async function pump(input: {
  processor: PiProcessor;
  stream: MemoryStream;
  cursors: Map<object, number>;
  until: () => boolean;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    const cursor = input.cursors.get(input.processor) ?? 0;
    const events = input.stream.events.slice(cursor);
    input.cursors.set(input.processor, input.stream.events.length);
    if (events.length > 0) {
      await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
    }
    if (input.until()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("pump timed out");
}

type LlmHandler = (
  request: PiLlmRequest,
  signal: AbortSignal,
) => PiAssistantMessage | Promise<PiAssistantMessage>;

function fakeLlm() {
  const handlers: LlmHandler[] = [];
  const requests: PiLlmRequest[] = [];
  return {
    requests,
    enqueue(handler: LlmHandler) {
      handlers.push(handler);
    },
    llm: {
      async complete(request: PiLlmRequest, options: { signal: AbortSignal }) {
        requests.push(request);
        const handler = handlers.shift();
        if (handler === undefined) throw new Error("no LLM handler queued");
        return await handler(request, options.signal);
      },
    },
  };
}

function assistantStop(text: string): PiAssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function assistantToolUse(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): PiAssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "toolCall" as const, ...call })),
    stopReason: "toolUse",
  };
}

/** Resolves its promise when the abort signal fires, mirroring a provider returning the streamed partial. */
function abortableHandler(partialText: string): LlmHandler {
  return (_request, signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () =>
        resolve({
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          stopReason: "aborted",
        }),
      );
    });
}

function echoTool(): PiToolDep {
  return {
    description: "Echoes the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async (args) => ({ content: `echo:${(args as { value: string }).value}` }),
  };
}

function setup(input?: { tools?: Record<string, PiToolDep> }) {
  const stream = new MemoryStream();
  const llm = fakeLlm();
  const processor = new PiProcessor({ stream, llm: llm.llm, tools: input?.tools ?? {} });
  const cursors = new Map<object, number>();
  return {
    stream,
    llm,
    processor,
    cursors,
    run: (until: () => boolean, timeoutMs?: number) =>
      pump({ processor, stream, cursors, until, timeoutMs }),
    eventsOfType: (type: string) => stream.events.filter((event) => event.type === type),
  };
}

const USER_MESSAGE = "events.iterate.com/pi/user-message-received";
const ASSISTANT_ADDED = "events.iterate.com/pi/assistant-message-added";
const TOOL_RESULT = "events.iterate.com/pi/tool-result-added";
const LLM_REQUESTED = "events.iterate.com/pi/llm-request-requested";
const COMPACTION_COMPLETED = "events.iterate.com/pi/compaction-completed";

describe("pi processor: turn taking", () => {
  it("runs a simple turn: prompt → llm request → assistant stop → idle", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup();
    llm.enqueue(() => assistantStop("hello!"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "hi" } });
    await run(() => processor.state.run.phase === "idle" && processor.state.history.length === 2);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(llm.requests[0]?.systemPrompt).toContain("coding agent");
    expect(eventsOfType(LLM_REQUESTED)).toHaveLength(1);
    expect(processor.state.history.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(processor.state.pendingTrigger).toBe(false);
  });

  it("loops through tool calls: toolUse → parallel results in source order → next request → stop", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup({ tools: { echo: echoTool() } });
    llm.enqueue(() =>
      assistantToolUse([
        { id: "t1", name: "echo", arguments: { value: "a" } },
        { id: "t2", name: "echo", arguments: { value: "b" } },
      ]),
    );
    llm.enqueue(() => assistantStop("done"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(
      () => eventsOfType(ASSISTANT_ADDED).length === 2 && processor.state.run.phase === "idle",
    );

    const toolResults = eventsOfType(TOOL_RESULT);
    expect(
      toolResults.map((event) => (event.payload as { toolCallId: string }).toolCallId),
    ).toEqual(["t1", "t2"]);
    // The second request replays the whole tool exchange.
    expect(llm.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(llm.requests[1]?.messages[2]).toMatchObject({ content: "echo:a", isError: false });
    // Tool definitions ride along as JSON schema.
    expect(llm.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: "echo", description: "Echoes the value back." }),
    ]);
  });

  it("turns unknown tools and invalid arguments into error results and keeps looping", async () => {
    const { stream, llm, processor, run } = setup({ tools: { echo: echoTool() } });
    llm.enqueue(() =>
      assistantToolUse([
        { id: "t1", name: "missing", arguments: {} },
        { id: "t2", name: "echo", arguments: { value: 42 } },
      ]),
    );
    llm.enqueue(() => assistantStop("recovered"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(() => llm.requests.length === 2 && processor.state.run.phase === "idle");

    const results = llm.requests[1]?.messages.filter((message) => message.role === "toolResult");
    expect(results?.[0]).toMatchObject({ isError: true, content: "Tool missing not found" });
    expect(results?.[1]?.isError).toBe(true);
    expect(results?.[1]?.content).toContain("Invalid arguments for tool echo");
  });

  it("ends the turn without another llm call when every result terminates", async () => {
    const terminating: PiToolDep = {
      description: "Ends the turn.",
      parameters: z.object({}),
      execute: async () => ({ content: "finished", terminate: true }),
    };
    const { stream, llm, processor, run, eventsOfType } = setup({ tools: { finish: terminating } });
    llm.enqueue(() => assistantToolUse([{ id: "t1", name: "finish", arguments: {} }]));
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(() => eventsOfType(TOOL_RESULT).length === 1 && processor.state.run.phase === "idle");
    // Let any (incorrect) trailing request surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await run(() => true);

    expect(eventsOfType(LLM_REQUESTED)).toHaveLength(1);
    expect(processor.state.pendingTrigger).toBe(false);
  });

  it("runs the whole batch sequentially when any called tool demands it", async () => {
    const order: string[] = [];
    const sequential: PiToolDep = {
      description: "Slow sequential tool.",
      executionMode: "sequential",
      parameters: z.object({ value: z.string() }),
      execute: async (args) => {
        order.push(`start:${(args as { value: string }).value}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end:${(args as { value: string }).value}`);
        return { content: "ok" };
      },
    };
    const { stream, llm, processor, run } = setup({ tools: { seq: sequential } });
    llm.enqueue(() =>
      assistantToolUse([
        { id: "t1", name: "seq", arguments: { value: "one" } },
        { id: "t2", name: "seq", arguments: { value: "two" } },
      ]),
    );
    llm.enqueue(() => assistantStop("done"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(() => llm.requests.length === 2 && processor.state.run.phase === "idle");

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });
});

describe("pi processor: steering and follow-up queues", () => {
  it("injects steered messages after the turn, then drains follow-ups when the run would stop", async () => {
    const { stream, llm, processor, run } = setup();
    let releaseFirst: (() => void) | undefined;
    llm.enqueue(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(assistantStop("first"));
        }),
    );
    llm.enqueue(() => assistantStop("second"));
    llm.enqueue(() => assistantStop("third"));

    await stream.append({ type: USER_MESSAGE, payload: { text: "start" } });
    await run(() => releaseFirst !== undefined);
    await stream.append(
      { type: USER_MESSAGE, payload: { text: "steer me", whileRunning: "steer" } },
      { type: USER_MESSAGE, payload: { text: "and then this", whileRunning: "follow-up" } },
    );
    await run(() => processor.state.steeringQueue.length === 1);
    releaseFirst?.();
    await run(() => llm.requests.length === 3 && processor.state.run.phase === "idle");

    // Steering entered context right after the first assistant turn…
    expect(llm.requests[1]?.messages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual([
      "start",
      "assistant",
      "steer me",
    ]);
    // …and the follow-up only ran once the run had nothing left to do.
    expect(llm.requests[2]?.messages.at(-1)).toEqual({ role: "user", content: "and then this" });
    expect(processor.state.followUpQueue).toEqual([]);
  });
});

describe("pi processor: interruption", () => {
  it("abort during streaming keeps the partial, clears queues, and skips it on the next request", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup();
    llm.enqueue(abortableHandler("partial thought"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "hi" } });
    await run(() => processor.state.run.phase === "streaming");
    await stream.append(
      { type: USER_MESSAGE, payload: { text: "queued", whileRunning: "steer" } },
      { type: "events.iterate.com/pi/abort-requested", payload: {} },
    );
    await run(
      () => eventsOfType(ASSISTANT_ADDED).length === 1 && processor.state.history.length === 2,
    );

    expect(processor.state.run.phase).toBe("idle");
    expect(processor.state.steeringQueue).toEqual([]);
    expect(processor.state.pendingTrigger).toBe(false);
    const aborted = processor.state.history[1]?.message;
    expect(aborted).toMatchObject({ role: "assistant", stopReason: "aborted" });

    // The next prompt replays context without the aborted partial.
    llm.enqueue(() => assistantStop("fresh"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "again" } });
    await run(() => llm.requests.length === 2 && processor.state.run.phase === "idle");
    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });

  it("abort during tools stops unexecuted calls; the next request synthesizes their missing results", async () => {
    const blocker: PiToolDep = {
      description: "Runs until aborted.",
      executionMode: "sequential",
      parameters: z.object({}),
      execute: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("tool aborted")));
        }),
    };
    const { stream, llm, processor, run, eventsOfType } = setup({
      tools: { echo: echoTool(), blocker },
    });
    llm.enqueue(() =>
      assistantToolUse([
        { id: "t1", name: "echo", arguments: { value: "a" } },
        { id: "t2", name: "blocker", arguments: {} },
        { id: "t3", name: "echo", arguments: { value: "never" } },
      ]),
    );
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(() => eventsOfType(TOOL_RESULT).length === 1);
    await stream.append({ type: "events.iterate.com/pi/abort-requested", payload: {} });
    await run(() => eventsOfType(TOOL_RESULT).length === 2 && processor.state.run.phase === "idle");

    // t3 never executed and never got an event.
    const resultIds = eventsOfType(TOOL_RESULT).map(
      (event) => (event.payload as { toolCallId: string }).toolCallId,
    );
    expect(resultIds).toEqual(["t1", "t2"]);

    llm.enqueue(() => assistantStop("resumed"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "continue" } });
    await run(() => llm.requests.length === 2 && processor.state.run.phase === "idle");
    const replayed = llm.requests[1]?.messages;
    expect(replayed?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(replayed?.[4]).toMatchObject({
      toolCallId: "t3",
      content: "No result provided",
      isError: true,
    });
  });
});

describe("pi processor: compaction", () => {
  it("compacts past the threshold and replays the summary as a tagged user message", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup();
    await stream.append({
      type: "events.iterate.com/pi/config-updated",
      payload: {
        contextWindow: 300,
        compactionSettings: { reserveTokens: 100, keepRecentTokens: 150 },
      },
    });
    const longText = (seed: string) => seed.repeat(Math.ceil(400 / seed.length)).slice(0, 400);
    llm.enqueue(() => assistantStop(longText("alpha ")));
    await stream.append({ type: USER_MESSAGE, payload: { text: longText("question one ") } });
    await run(() => llm.requests.length === 1 && processor.state.run.phase === "idle");

    // The second prompt pushes the estimate over the threshold, so compaction
    // runs BEFORE the request is issued (compaction has priority over a
    // pending trigger), and the turn then runs against the compacted context.
    llm.enqueue(() => assistantStop("## Goal\nSummarized."));
    llm.enqueue(() => assistantStop(longText("beta ")));
    await stream.append({ type: USER_MESSAGE, payload: { text: longText("question two ") } });
    await run(() => llm.requests.length === 3 && processor.state.run.phase === "idle");

    expect(eventsOfType(COMPACTION_COMPLETED)).toHaveLength(1);
    // Summary + the kept recent turn.
    expect(processor.state.history.map((entry) => entry.message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    // The summarizer got the dropped slice and pi's structured prompt.
    const summarizeRequest = llm.requests[1];
    expect(summarizeRequest?.systemPrompt).toContain("context summarization assistant");
    expect(summarizeRequest?.messages[0]?.content).toContain("question one");
    expect(summarizeRequest?.messages[0]?.content).toContain("## Goal");
    // The turn request replays the summary as pi's tagged user message.
    const first = llm.requests[2]?.messages[0];
    expect(first?.role).toBe("user");
    expect(first?.content).toContain("<summary>");
    expect(first?.content).toContain("Summarized.");
    expect(llm.requests[2]?.messages.at(-1)?.content).toContain("question two");
  });

  it("recovers from a provider overflow error: compact, then retry once", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup();
    await stream.append({
      type: "events.iterate.com/pi/config-updated",
      payload: { compactionSettings: { keepRecentTokens: 10 } },
    });
    llm.enqueue(() => assistantStop("a".repeat(200)));
    await stream.append({ type: USER_MESSAGE, payload: { text: "first question about things" } });
    await run(() => llm.requests.length === 1 && processor.state.run.phase === "idle");

    llm.enqueue(() => ({
      role: "assistant",
      content: [],
      errorMessage: "prompt is too long: 210000 tokens > 200000 maximum",
      stopReason: "error",
    }));
    llm.enqueue(() => assistantStop("## Goal\nRecovered summary."));
    llm.enqueue(() => assistantStop("worked this time"));
    await stream.append({
      type: USER_MESSAGE,
      payload: { text: "second question, quite long too" },
    });
    await run(() => llm.requests.length === 4 && processor.state.run.phase === "idle");

    expect(eventsOfType(COMPACTION_COMPLETED)).toHaveLength(1);
    expect(processor.state.overflowRecoveryAttempted).toBe(false); // reset by the successful retry
    // The retried request starts from the compacted context.
    expect(llm.requests[3]?.messages[0]?.content).toContain("Recovered summary.");
    expect(llm.requests[3]?.messages.at(-1)).toMatchObject({
      content: "second question, quite long too",
    });
  });
});

describe("pi processor: restarts and replay", () => {
  it("re-issues an llm request that a restart killed mid-flight", async () => {
    const stream = new MemoryStream();
    await stream.append(
      { type: USER_MESSAGE, payload: { text: "hi" } },
      { type: LLM_REQUESTED, payload: { generation: 0 } },
    );
    const checkpointState = reducePiEvents(stream.events);
    expect(checkpointState.run.phase).toBe("streaming");

    const llm = fakeLlm();
    llm.enqueue(() => assistantStop("recovered"));
    const processor = new PiProcessor({
      stream,
      llm: llm.llm,
      tools: {},
      readState: async () => ({ offset: 2, state: checkpointState }),
    });
    const cursors = new Map<object, number>();
    // Nothing replays (checkpoint covers everything); the next event triggers settle.
    await stream.append({ type: "events.iterate.com/pi/config-updated", payload: {} });
    await pump({
      processor,
      stream,
      cursors,
      until: () =>
        stream.events.some((event) => event.type === ASSISTANT_ADDED) &&
        processor.state.run.phase === "idle",
    });
    expect(llm.requests).toHaveLength(1);
    expect(processor.state.history.at(-1)?.message).toMatchObject({ role: "assistant" });
  });

  it("synthesizes error results for tool executions a restart lost, instead of re-running them", async () => {
    const wedge: PiToolDep = {
      description: "Never finishes.",
      parameters: z.object({}),
      execute: () => new Promise(() => {}),
    };
    const first = setup({ tools: { wedge } });
    first.llm.enqueue(() => assistantToolUse([{ id: "t1", name: "wedge", arguments: {} }]));
    await first.stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await first.run(() => first.processor.state.run.phase === "executing-tools");

    // "Restart": a fresh instance resumes from the first one's checkpoint.
    const snapshot = await first.processor.snapshot();
    const llm = fakeLlm();
    llm.enqueue(() => assistantStop("carried on"));
    const revived = new PiProcessor({
      stream: first.stream,
      llm: llm.llm,
      tools: { wedge },
      readState: async () => snapshot,
    });
    const cursors = new Map<object, number>();
    await first.stream.append({ type: "events.iterate.com/pi/config-updated", payload: {} });
    await pump({
      processor: revived,
      stream: first.stream,
      cursors,
      until: () => revived.state.run.phase === "idle" && llm.requests.length === 1,
    });

    const results = first.stream.events.filter((event) => event.type === TOOL_RESULT);
    expect(results).toHaveLength(1);
    expect((results[0]!.payload as { content: string }).content).toContain("lost in a restart");
    // The loop continued: the synthesized error went back to the model.
    expect(llm.requests[0]?.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
  });

  it("replaying the full journal into a fresh processor re-executes nothing", async () => {
    const { stream, llm, processor, run } = setup({ tools: { echo: echoTool() } });
    llm.enqueue(() => assistantToolUse([{ id: "t1", name: "echo", arguments: { value: "a" } }]));
    llm.enqueue(() => assistantStop("done"));
    await stream.append({ type: USER_MESSAGE, payload: { text: "go" } });
    await run(() => llm.requests.length === 2 && processor.state.run.phase === "idle");
    const eventCountBefore = stream.events.length;
    const llmCallsBefore = llm.requests.length;

    const replayed = new PiProcessor({ stream, llm: llm.llm, tools: { echo: echoTool() } });
    await replayed.ingest({ events: [...stream.events], streamMaxOffset: stream.events.length });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stream.events.length).toBe(eventCountBefore);
    expect(llm.requests.length).toBe(llmCallsBefore);
    expect(replayed.state).toEqual(processor.state);
  });
});

describe("buildPiLlmRequest", () => {
  it("drops error/aborted assistant messages and orphaned late tool results", () => {
    const toolCall: PiToolCall = { type: "toolCall", id: "t1", name: "echo", arguments: {} };
    const state = PiProcessorContract.stateSchema.parse({
      history: [
        { offset: 1, message: { role: "user", content: "hi" } },
        {
          offset: 2,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }, toolCall],
            stopReason: "aborted",
          },
        },
        // A late result whose call was dropped with the aborted message above.
        {
          offset: 3,
          message: {
            role: "toolResult",
            content: "late",
            isError: false,
            toolCallId: "t1",
            toolName: "echo",
          },
        },
        { offset: 4, message: { role: "user", content: "again" } },
      ],
    });
    expect(buildPiLlmRequest(state).messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });

  it("synthesizes results for tool calls that never completed, before the next message", () => {
    const state = PiProcessorContract.stateSchema.parse({
      history: [
        { offset: 1, message: { role: "user", content: "hi" } },
        {
          offset: 2,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "t1", name: "echo", arguments: {} },
              { type: "toolCall", id: "t2", name: "echo", arguments: {} },
            ],
            stopReason: "toolUse",
          },
        },
        {
          offset: 3,
          message: {
            role: "toolResult",
            content: "done",
            isError: false,
            toolCallId: "t1",
            toolName: "echo",
          },
        },
        { offset: 4, message: { role: "user", content: "interrupting" } },
      ],
    });
    const messages = buildPiLlmRequest(state).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(messages[3]).toMatchObject({
      toolCallId: "t2",
      content: "No result provided",
      isError: true,
    });
  });
});
