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
  buildSummarizationRequest,
  compactionToRequest,
  estimatePiContextTokens,
  findCompactionCutIndex,
  isOverflowErrorMessage,
  lostToolCalls,
  planCompaction,
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

  it("ignores a request event that raced past an abort (abort bumps the generation)", async () => {
    // Stream order: the prompt, then the abort, then a request event that was
    // appended (keyed on generation 0) before the abort landed. The fold must
    // treat the request as stale — no model call for a cancelled prompt.
    const { stream, llm, processor, run, eventsOfType } = setup();
    await stream.append(
      { type: USER_MESSAGE, payload: { text: "hi" } },
      { type: "events.iterate.com/pi/abort-requested", payload: {} },
      { type: LLM_REQUESTED, payload: { generation: 0 } },
    );
    // The abort bumps the generation to 1; the stale request event retires its
    // spent idempotency key by bumping it again.
    await run(() => processor.state.generation === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await run(() => true);

    expect(processor.state.run.phase).toBe("idle");
    expect(processor.state.pendingTrigger).toBe(false);
    expect(llm.requests).toHaveLength(0);
    expect(eventsOfType(ASSISTANT_ADDED)).toHaveLength(0);
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

  it("parks a failed compaction until history grows, then retries with a fresh key", async () => {
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

    // Over the threshold now. The summarizer fails; the failure parks on the
    // current history tail and the pending turn still runs. The turn's answer
    // moves the tail, so compaction retries — with a fresh epoch key — and
    // succeeds on the second attempt.
    llm.enqueue(() => ({
      role: "assistant",
      content: [],
      errorMessage: "summarizer down",
      stopReason: "error",
    }));
    llm.enqueue(() => assistantStop("turn two answer"));
    llm.enqueue(() => assistantStop("## Goal\nfinally summarized"));
    await stream.append({ type: USER_MESSAGE, payload: { text: longText("question two ") } });
    await run(
      () =>
        processor.state.history[0]?.message.role === "compactionSummary" &&
        processor.state.run.phase === "idle",
    );

    const statuses = eventsOfType(COMPACTION_COMPLETED).map(
      (event) => (event.payload as { result: { status: string } }).result.status,
    );
    expect(statuses).toEqual(["failure", "success"]);
    expect(processor.state.compactionFailedForTailOffset).toBeNull();
    expect(processor.state.history[0]?.message.role).toBe("compactionSummary");
    expect(processor.state.history.at(-1)?.message).toMatchObject({ role: "assistant" });
  });

  it("folds the previous summary through a second compaction (no summary pile-up)", async () => {
    const { stream, llm, processor, run, eventsOfType } = setup();
    await stream.append({
      type: "events.iterate.com/pi/config-updated",
      payload: {
        contextWindow: 300,
        compactionSettings: { reserveTokens: 100, keepRecentTokens: 150 },
      },
    });
    const longText = (seed: string) => seed.repeat(Math.ceil(400 / seed.length)).slice(0, 400);
    const turn = async (question: string, ...handlers: LlmHandler[]) => {
      for (const handler of handlers) llm.enqueue(handler);
      const before = llm.requests.length;
      await stream.append({ type: USER_MESSAGE, payload: { text: question } });
      await run(
        () =>
          llm.requests.length === before + handlers.length && processor.state.run.phase === "idle",
      );
    };

    await turn(longText("question one "), () => assistantStop(longText("alpha ")));
    // Turn two crosses the threshold: summarize, then answer.
    await turn(
      longText("question two "),
      () => assistantStop("## Goal\nfirst summary"),
      () => assistantStop(longText("beta ")),
    );
    // Turn three crosses it again: the second summarize sees the first summary.
    await turn(
      longText("question three "),
      () => assistantStop("## Goal\nmerged summary"),
      () => assistantStop("final answer"),
    );

    expect(eventsOfType(COMPACTION_COMPLETED)).toHaveLength(2);
    const secondSummarize = llm.requests.find((request) =>
      request.messages[0]?.content.toString().includes("<previous-summary>"),
    );
    expect(secondSummarize?.messages[0]?.content).toContain("first summary");
    // Exactly one summary survives in history — the merged one.
    const summaries = processor.state.history.filter(
      (entry) => entry.message.role === "compactionSummary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.message).toMatchObject({ summary: expect.stringContaining("merged") });
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

/**
 * Build a hand-rolled event journal for pure fold tests: no processor, no
 * stream, no async — the state machine exercised event by event.
 */
function journal() {
  const events: StreamEvent[] = [];
  const push = (type: string, payload: Record<string, unknown>): number => {
    events.push({
      type,
      payload,
      createdAt: new Date(events.length + 1).toISOString(),
      offset: events.length + 1,
    });
    return events.length;
  };
  return { events, push, state: () => reducePiEvents(events) };
}

describe("pi fold (pure unit tests)", () => {
  it("walks a full turn through the state machine", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "hi" });
    expect(j.state()).toMatchObject({ pendingTrigger: true, run: { phase: "idle" } });

    const requestOffset = j.push(LLM_REQUESTED, { generation: 0 });
    expect(j.state()).toMatchObject({
      pendingTrigger: false,
      run: { phase: "streaming", llmRequestId: requestOffset },
    });

    j.push(ASSISTANT_ADDED, { llmRequestId: requestOffset, message: assistantStop("hello") });
    expect(j.state()).toMatchObject({
      generation: 1,
      pendingTrigger: false,
      run: { phase: "idle" },
    });
    expect(j.state().history.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
  });

  it("drives the tool loop: executing-tools, mixed terminate votes keep looping", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "go" });
    const requestOffset = j.push(LLM_REQUESTED, { generation: 0 });
    const assistantOffset = j.push(ASSISTANT_ADDED, {
      llmRequestId: requestOffset,
      message: assistantToolUse([
        { id: "t1", name: "a", arguments: {} },
        { id: "t2", name: "b", arguments: {} },
      ]),
    });
    expect(j.state().run).toMatchObject({
      phase: "executing-tools",
      pendingToolCallIds: ["t1", "t2"],
    });

    j.push(TOOL_RESULT, {
      assistantOffset,
      content: "done",
      isError: false,
      terminate: true,
      toolCallId: "t1",
      toolName: "a",
    });
    expect(j.state().run).toMatchObject({ phase: "executing-tools", pendingToolCallIds: ["t2"] });

    // One terminate vote is not enough — pi ends the turn only when EVERY
    // result terminates, so a mixed batch continues the loop.
    j.push(TOOL_RESULT, {
      assistantOffset,
      content: "done",
      isError: false,
      toolCallId: "t2",
      toolName: "b",
    });
    expect(j.state()).toMatchObject({ pendingTrigger: true, run: { phase: "idle" } });
  });

  it("queues while running: steering drains at the turn boundary, follow-ups only when stopping", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "start" });
    const r1 = j.push(LLM_REQUESTED, { generation: 0 });
    j.push(USER_MESSAGE, { text: "steer", whileRunning: "steer" });
    j.push(USER_MESSAGE, { text: "later", whileRunning: "follow-up" });
    expect(j.state()).toMatchObject({ steeringQueue: ["steer"], followUpQueue: ["later"] });

    j.push(ASSISTANT_ADDED, { llmRequestId: r1, message: assistantStop("first") });
    // Steering entered history and re-triggered; the follow-up stays queued.
    const drained = j.state();
    expect(drained.steeringQueue).toEqual([]);
    expect(drained.followUpQueue).toEqual(["later"]);
    expect(drained.pendingTrigger).toBe(true);
    expect(drained.history.at(-1)?.message).toEqual({ role: "user", content: "steer" });

    const r2 = j.push(LLM_REQUESTED, { generation: 1 });
    j.push(ASSISTANT_ADDED, { llmRequestId: r2, message: assistantStop("second") });
    // Nothing left to do: now the follow-up drains and re-triggers.
    expect(j.state()).toMatchObject({ followUpQueue: [], pendingTrigger: true });
  });

  it("an error response ends the run dead: queues stay queued, nothing re-triggers (pi semantics)", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "start" });
    const r1 = j.push(LLM_REQUESTED, { generation: 0 });
    j.push(USER_MESSAGE, { text: "steer", whileRunning: "steer" });
    j.push(ASSISTANT_ADDED, {
      llmRequestId: r1,
      message: {
        role: "assistant",
        content: [],
        errorMessage: "provider exploded",
        stopReason: "error",
      },
    });
    expect(j.state()).toMatchObject({
      pendingTrigger: false,
      run: { phase: "idle" },
      steeringQueue: ["steer"],
    });
  });

  it("a stale request event retires its spent generation key", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "hi" });
    j.push("events.iterate.com/pi/abort-requested", {});
    j.push(LLM_REQUESTED, { generation: 0 });
    // abort: 0→1; stale request: 1→2 — the next derivation uses a fresh key.
    expect(j.state()).toMatchObject({
      generation: 2,
      pendingTrigger: false,
      run: { phase: "idle" },
    });
  });

  it("compaction-requested is a no-op unless the run is settled idle", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "hi" });
    j.push(LLM_REQUESTED, { generation: 0 });
    j.push("events.iterate.com/pi/compaction-requested", { reason: "threshold", tailOffset: 1 });
    expect(j.state().compaction).toBeNull();
  });

  it("compaction splices by index, bumps the epoch, and fences the overflow retrigger on the generation", () => {
    const makeJournal = (abortBeforeCompletion: boolean) => {
      const j = journal();
      j.push(USER_MESSAGE, { text: "one" });
      const r1 = j.push(LLM_REQUESTED, { generation: 0 });
      j.push(ASSISTANT_ADDED, { llmRequestId: r1, message: assistantStop("answer one") });
      j.push(USER_MESSAGE, { text: "two" });
      const requested = j.push("events.iterate.com/pi/compaction-requested", {
        reason: "overflow",
        tailOffset: 4,
      });
      if (abortBeforeCompletion) j.push("events.iterate.com/pi/abort-requested", {});
      j.push("events.iterate.com/pi/compaction-completed", {
        requestedOffset: requested,
        result: {
          status: "success",
          firstKeptIndex: 2, // keep from "two" onward
          summary: "## Goal\nsummarized",
          tokensBefore: 123,
        },
      });
      return j.state();
    };

    const completed = makeJournal(false);
    expect(completed.history.map((entry) => entry.message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
    expect(completed.compactionEpoch).toBe(1);
    expect(completed.pendingTrigger).toBe(true); // overflow recovery retries

    // An abort between request and completion moves the generation, so the
    // retry is suppressed — the user said stop.
    const aborted = makeJournal(true);
    expect(aborted.pendingTrigger).toBe(false);
    expect(aborted.history.map((entry) => entry.message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
  });

  it("a failed compaction parks on the history tail", () => {
    const j = journal();
    j.push(USER_MESSAGE, { text: "one" });
    const requested = j.push("events.iterate.com/pi/compaction-requested", {
      reason: "threshold",
      tailOffset: 1,
    });
    j.push("events.iterate.com/pi/compaction-completed", {
      requestedOffset: requested,
      result: { status: "failure", error: { message: "summarizer down" } },
    });
    expect(j.state()).toMatchObject({
      compaction: null,
      compactionEpoch: 1,
      compactionFailedForTailOffset: 1,
    });
  });
});

describe("pi settle policy (pure unit tests)", () => {
  const baseState = (history: unknown[], overrides?: Record<string, unknown>) =>
    PiProcessorContract.stateSchema.parse({
      contextWindow: 300,
      compactionSettings: { reserveTokens: 100, keepRecentTokens: 150 },
      history,
      ...overrides,
    });
  const userEntry = (offset: number, chars: number) => ({
    offset,
    message: { role: "user", content: "x".repeat(chars) },
  });
  const assistantEntry = (offset: number, chars: number) => ({
    offset,
    message: assistantStop("y".repeat(chars)),
  });

  it("requests threshold compaction only past contextWindow - reserveTokens, with a useful cut", () => {
    expect(compactionToRequest(baseState([userEntry(1, 400), assistantEntry(2, 300)]))).toBeNull();
    const over = baseState([
      userEntry(1, 400),
      assistantEntry(2, 400),
      userEntry(3, 400),
      assistantEntry(4, 400),
    ]);
    expect(compactionToRequest(over)).toEqual({ reason: "threshold", tailOffset: 4 });
  });

  it("requests overflow compaction for an unrecovered overflow error even under the threshold", () => {
    // ~110 estimated tokens — well under the 200-token threshold — but the
    // provider said overflow, so compaction happens anyway (small keep budget
    // so a valid cut exists).
    const history = [
      userEntry(1, 200),
      assistantEntry(2, 200),
      userEntry(3, 40),
      {
        offset: 4,
        message: {
          role: "assistant",
          content: [],
          errorMessage: "prompt is too long: 210000 tokens",
          stopReason: "error",
        },
      },
    ];
    const smallKeep = { compactionSettings: { reserveTokens: 100, keepRecentTokens: 20 } };
    expect(compactionToRequest(baseState(history, smallKeep))).toEqual({
      reason: "overflow",
      tailOffset: 4,
    });
    expect(
      compactionToRequest(baseState(history, { ...smallKeep, overflowRecoveryAttempted: true })),
    ).toBeNull();
  });

  it("stays parked while the history tail has not moved past a failed compaction", () => {
    const history = [
      userEntry(1, 400),
      assistantEntry(2, 400),
      userEntry(3, 400),
      assistantEntry(4, 400),
    ];
    expect(
      compactionToRequest(baseState(history, { compactionFailedForTailOffset: 4 })),
    ).toBeNull();
    expect(compactionToRequest(baseState(history, { compactionFailedForTailOffset: 2 }))).toEqual({
      reason: "threshold",
      tailOffset: 4,
    });
  });

  it("ignores usage anchors that predate the last compaction", () => {
    // The kept assistant message reports the token count of the context that
    // FORCED the compaction; trusting it would demand compaction forever.
    const staleUsage = {
      offset: 5,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
        stopReason: "stop",
        usage: { input: 250, output: 10, totalTokens: 260 },
      },
    };
    const history = [
      { offset: 9, message: { role: "compactionSummary", summary: "## Goal\nshort" } },
      staleUsage,
      userEntry(10, 40),
    ];
    expect(estimatePiContextTokens(baseState(history).history)).toBeLessThan(50);
    expect(compactionToRequest(baseState(history))).toBeNull();
  });

  it("resolves lost tool calls from the assistant message that issued them", () => {
    const state = baseState(
      [
        userEntry(1, 10),
        {
          offset: 3,
          message: assistantToolUse([
            { id: "t1", name: "read", arguments: {} },
            { id: "t2", name: "bash", arguments: {} },
          ]),
        },
      ],
      {
        run: {
          phase: "executing-tools",
          allResultsTerminate: true,
          assistantOffset: 3,
          pendingToolCallIds: ["t2"],
        },
      },
    );
    expect(lostToolCalls(state)).toEqual([{ toolCallId: "t2", toolName: "bash" }]);
  });
});

describe("pi compaction helpers (pure unit tests)", () => {
  it("cuts at a user message after the keep-recent walk, never inside a turn", () => {
    const history = PiProcessorContract.stateSchema.parse({
      history: [
        { offset: 1, message: { role: "user", content: "a".repeat(400) } },
        { offset: 2, message: assistantStop("b".repeat(400)) },
        { offset: 3, message: { role: "user", content: "c".repeat(400) } },
        { offset: 4, message: assistantStop("d".repeat(400)) },
      ],
    }).history;
    // keep ~150 tokens: the walk stops inside turn 2, snaps forward to user@2.
    expect(findCompactionCutIndex(history, 150)).toBe(2);
    // Everything fits in the keep budget: nothing to compact.
    expect(findCompactionCutIndex(history, 10_000)).toBeNull();
  });

  it("folds the previous summary into the next one instead of re-summarizing it", () => {
    const state = PiProcessorContract.stateSchema.parse({
      compactionSettings: { keepRecentTokens: 150 },
      history: [
        { offset: 5, message: { role: "compactionSummary", summary: "## Goal\nold summary" } },
        { offset: 1, message: { role: "user", content: "a".repeat(400) } },
        { offset: 2, message: assistantStop("b".repeat(400)) },
        { offset: 3, message: { role: "user", content: "c".repeat(400) } },
        { offset: 4, message: assistantStop("d".repeat(400)) },
      ],
    });
    const plan = planCompaction(state);
    expect(plan).toMatchObject({ firstKeptIndex: 3, previousSummary: "## Goal\nold summary" });
    expect(plan?.entriesToSummarize.map((entry) => entry.offset)).toEqual([1, 2]);

    const request = buildSummarizationRequest({ plan: plan!, state });
    expect(request.messages[0]?.content).toContain("<previous-summary>");
    expect(request.messages[0]?.content).toContain("old summary");
  });

  it("classifies overflow error messages", () => {
    expect(isOverflowErrorMessage("prompt is too long: 210000 tokens > 200000")).toBe(true);
    expect(isOverflowErrorMessage("input exceeds the available context size")).toBe(true);
    expect(isOverflowErrorMessage("rate limit exceeded, too many tokens per minute")).toBe(false);
    expect(isOverflowErrorMessage("internal server error")).toBe(false);
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
