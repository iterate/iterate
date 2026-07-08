import { describe, expect, it } from "vitest";
import type { StreamEventInput } from "../streams/schemas.ts";
import {
  AgentProcessor,
  buildAgentLlmRequestBody,
  flattenMessageToText,
  reduceAgentEvents,
} from "./agent-processor-implementation.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
} from "./agent-processor-contract.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import { OpenAiWsProcessor } from "./openai-ws-processor-implementation.ts";
import {
  MemoryStream,
  deliverNewEvents,
  fakeResponsesWebSocket,
  type FakeResponsesWebSocket,
  type ProcessorLike,
} from "./test-helpers.ts";

function openAiWsRequestEvents(content: string): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/agent/input-added",
      payload: { content, llmRequestPolicy: { behaviour: "after-current-request" } },
    },
    {
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: {
        debounceMs: 0,
        model: "gpt-5.5",
        provider: "openai-ws",
        requestId: "llm-request:1",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-5.5", provider: "openai-ws", requestId: "llm-request:1" },
    },
  ];
}

function sseStream(...chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("minimal web-chat agent processors", () => {
  it("explains the exact codemode shape expected by the ITX script runner", () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      "The block must contain a single async arrow function",
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("async (itx) => {");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("await itx.chat.sendMessage(message)");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain("containing an async function");
    // The verbatim type surface rides along so the agent knows what it holds.
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("RpcStub<Project>");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("export interface Project {");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("export interface CapabilityHost {");
    // Tool-call stance: small data-first snippets, parallel fan-out, explicit
    // loop-ending rule, and the built-in discovery surfaces.
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Promise.all");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("returns undefined ends your turn");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("itx.mcp.exa.web_search_exa");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("itx.examples.list()");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      'itx.integrations.google["<connection>"].gmail.request',
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("PROJECT REPO EDITS");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      'const repo = itx.repos.get(vars.repoPath ?? "/")',
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      "repo.edit({ path, message, oldString, newString })",
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("repo-read-file");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("repo-edit-file");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('path: "/users/me/messages"');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Do not tell the user you lack inbox access");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('path: "/gmail/v1/users/me/messages"');
  });

  it("feeds a returned script result back as input and schedules another turn", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result: { inbox: ["a", "b"] } },
    });
    await deliver();
    await deliver();

    const input = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(input?.payload?.content).toContain("Your script returned");
    expect(input?.payload?.content).toContain('"inbox"');
    expect(
      stream.events.some(
        (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
      ),
    ).toBe(true);
  });

  it("tracks in-progress script executions in reduced state", async () => {
    const stream = new MemoryStream();
    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-requested",
      payload: { executionId: "agent-output:7", code: "async (itx) => 7" },
    });

    const runningState = reduceAgentEvents(stream.events);
    expect(runningState.inProgressScriptExecutions).toEqual([
      {
        code: "async (itx) => 7",
        executionId: "agent-output:7",
        requestedOffset: 1,
        startedAt: stream.events[0]!.createdAt,
      },
    ]);

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result: 7 },
    });

    const completedState = reduceAgentEvents(stream.events);
    expect(completedState.inProgressScriptExecutions).toEqual([]);
    expect(completedState.scriptExecutionsCompleted).toEqual(["agent-output:7"]);
  });

  it("feeds a thrown script error back as input", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", error: "gmail exploded" },
    });
    await deliverNewEvents({ processor: agent, stream, cursors });

    const input = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(input?.payload?.content).toContain("Your script threw");
    expect(input?.payload?.content).toContain("gmail exploded");
  });

  it("ends the loop when a script returns nothing, and ignores foreign executions", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(
      // The agent's own script returned undefined — the completion event
      // carries no `result` key (see CapabilityHostProcessor#executeScript).
      {
        type: "events.iterate.com/capability-host/script-execution-completed",
        payload: { executionId: "agent-output:7" },
      },
      // A non-agent execution (e.g. a Slack bang command) on the same stream.
      {
        type: "events.iterate.com/capability-host/script-execution-completed",
        payload: { executionId: "slack-bang-command-9", result: { noisy: true } },
      },
    );
    await deliverNewEvents({ processor: agent, stream, cursors });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toEqual([]);
  });

  it("stops the agent loop instead of scheduling past the autonomous turn limit", async () => {
    const stream = new MemoryStream();
    await stream.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: "existing" },
    });
    const state = AgentProcessorContract.stateSchema.parse({
      autonomousTurnCount: DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
      pendingTriggerOffset: 1,
      pendingTriggerSource: "agent-loop",
    });
    const agent = new AgentProcessor({
      stream,
      readState: async () => ({ offset: 1, state }),
    });

    await stream.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: "next" },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    const stopped = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/loop-stopped",
    );
    expect(stopped?.payload).toMatchObject({
      maxAutonomousTurns: DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
      reason: expect.stringContaining(`${DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS}`),
      triggerOffset: 1,
    });
    expect(stream.events.some((event) => event.type === "events.iterate.com/stream/paused")).toBe(
      false,
    );
    expect(
      stream.events.some(
        (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
      ),
    ).toBe(false);
  });

  it("normalizes web input, requests AI by reference, and turns output into script execution", async () => {
    const stream = new MemoryStream();
    const aiCalls: unknown[] = [];
    const agent = new AgentProcessor({ stream });
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run(_model, body) {
          aiCalls.push(body);
          return {
            response: [
              "```js",
              "async (itx) => {",
              "  await itx.chat.sendMessage('hello from ai');",
              "}",
              "```",
            ].join("\n"),
          };
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "hello" },
    });
    await deliver(agent);
    await deliver(agent);
    await deliver(agent);
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(agent);
    await deliver(cloudflareAi);
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(agent);

    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/agents/user-message-received",
        "events.iterate.com/agent/input-added",
        "events.iterate.com/agent/llm-request-scheduled",
        "events.iterate.com/agent/llm-request-requested",
        "events.iterate.com/cloudflare-ai/llm-request-started",
        "events.iterate.com/agent/output-added",
        "events.iterate.com/cloudflare-ai/llm-request-completed",
        "events.iterate.com/agent/llm-request-completed",
        "events.iterate.com/capability-host/script-execution-requested",
      ]),
    );
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]).toMatchObject({
      stream: true,
      messages: [expect.objectContaining({ role: "system" }), { role: "user", content: "hello" }],
    });
  });

  it("treats MCP-origin messages like any other inbound user message", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "mcp", content: "how many agents does this project have?" },
    });
    await deliver(agent);
    await deliver(agent);

    expect(stream.events.map((event) => event.type)).toEqual([
      "events.iterate.com/agents/user-message-received",
      "events.iterate.com/agent/input-added",
      "events.iterate.com/agent/llm-request-scheduled",
    ]);
    expect(stream.events[1]!.payload).toMatchObject({
      content: "how many agents does this project have?",
    });
  });

  it("coalesces multiple triggering inputs delivered in one batch into one LLM request", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });

    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "message one",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "message two",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    );
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({ requestId: "llm-request:gen-0" });
  });

  it("coalesces triggering inputs even when delivery chunks them across batches", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });

    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "message one",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "message two",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    );

    // First chunk delivers only input one; its batch appends the scheduled
    // event at offset 3. The second chunk delivers only input two — a batch
    // that predates the scheduled event, so state still shows no current
    // request. The generation-keyed idempotency collapses the re-derived
    // schedule into the event already on the stream.
    await agent.ingest({ events: stream.events.slice(0, 1), streamMaxOffset: 2 });
    await agent.ingest({ events: stream.events.slice(1, 2), streamMaxOffset: 3 });

    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({ requestId: "llm-request:gen-0" });
  });

  it("coalesces multiple MCP-origin user messages replayed through the cold session backlog", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { origin: "mcp", content: "first ask from MCP" },
      },
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { origin: "mcp", content: "second ask from MCP" },
      },
    );

    await deliverNewEvents({ processor: agent, stream, cursors });
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(2);

    await deliverNewEvents({ processor: agent, stream, cursors });

    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({ requestId: "llm-request:gen-0" });
  });

  it("does not fire a second LLM call when a second message arrives during the first request", async () => {
    const stream = new MemoryStream();
    const aiCalls: unknown[] = [];
    let resolveFirstCall!: () => void;
    const firstCallInFlight = new Promise<void>((resolve) => {
      resolveFirstCall = resolve;
    });
    const agent = new AgentProcessor({ stream });
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run(_model, body) {
          aiCalls.push(body);
          resolveFirstCall();
          return { response: "```js\nasync (itx) => {}\n```" };
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    // First user message — triggers llm-request-scheduled (with debounce)
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "message one" },
    });
    await deliver(agent);
    await deliver(agent);
    await deliver(agent);

    // Second user message arrives before debounce fires — queued as pending
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "message two" },
    });
    await deliver(agent);

    // Wait for the LLM call to complete (both messages included in it)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(agent);
    await deliver(cloudflareAi);
    await firstCallInFlight;
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(agent);

    // Give the processor time to fire a spurious second request if the bug is present
    await new Promise((resolve) => setTimeout(resolve, 100));
    await deliver(agent);

    expect(aiCalls).toHaveLength(1);
    const firstCall = aiCalls[0] as { messages: Array<{ role: string; content: string }> };
    expect(firstCall.messages.map((m) => m.content)).toEqual(
      expect.arrayContaining(["message one", "message two"]),
    );
  });

  it("recovers a stuck scheduled request after DO restart (lost debounce timer)", async () => {
    const stream = new MemoryStream();
    // Simulate events already committed before restart
    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hello", llmRequestPolicy: { behaviour: "after-current-request" } },
      },
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 250,
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
    );
    // Simulate a checkpoint written after the scheduled event but before the timer fired
    const stuckState = AgentProcessorContract.stateSchema.parse({
      history: [{ role: "user", content: "hello" }],
      currentRequest: { phase: "scheduled", requestId: "llm-request:1", scheduledOffset: 2 },
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({
      stream,
      readState: async () => ({ offset: 2, state: stuckState }),
    });
    // New event arrives after restart — triggers recovery
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "second message" },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });
    // Recovery should fire llm-request-requested without waiting for a debounce
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 500,
    });
  });

  it("treats Workers AI terminal stream chunks without choices as successful completion", async () => {
    const stream = new MemoryStream();
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run() {
          return sseStream(
            { choices: [{ delta: { content: "```js\n" } }] },
            {
              choices: [
                {
                  delta: {
                    content:
                      "async (itx) => {\n  await itx.chat.sendMessage('real-ai-agent-ok');\n}\n```",
                  },
                },
              ],
            },
            {
              choices: [],
              usage: { completion_tokens: 12, prompt_tokens: 34, total_tokens: 46 },
            },
          );
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "send real-ai-agent-ok",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 0,
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
    );

    await deliverNewEvents({
      processor: cloudflareAi,
      stream,
      cursors: new Map<object, number>(),
    });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    const output = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/output-added"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      result: { status: "success" },
    });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("real-ai-agent-ok"),
    });
  });

  it("executes openai-ws requests over the Responses WebSocket and records every frame", async () => {
    const stream = new MemoryStream();
    const sockets: FakeResponsesWebSocket[] = [];
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        const socket = fakeResponsesWebSocket(() => [
          { type: "response.output_text.delta", delta: "```js\nasync (itx) => {}" },
          { type: "response.output_text.delta", delta: "\n```" },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { total_tokens: 7 } },
          },
        ]);
        sockets.push(socket);
        return socket;
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(...openAiWsRequestEvents("hello over ws"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    const output = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/output-added"],
      timeoutMs: 2_000,
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent[0]).toMatchObject({ type: "response.create", model: "gpt-5.5" });
    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/openai-ws/llm-request-started",
        "events.iterate.com/openai-ws/llm-response-chunk",
        "events.iterate.com/openai-ws/llm-request-completed",
      ]),
    );
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/openai-ws/llm-response-chunk",
      ),
    ).toHaveLength(3);
    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: { status: "success", usage: { total_tokens: 7 } },
    });
    expect(output.payload).toMatchObject({ content: "```js\nasync (itx) => {}\n```" });
  });

  it("retries openai-ws once with full input when a previous response id expires", async () => {
    const stream = new MemoryStream();
    const sockets: FakeResponsesWebSocket[] = [];
    let responseCreateCount = 0;
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        const socket = fakeResponsesWebSocket(() => {
          responseCreateCount += 1;
          if (responseCreateCount === 1) {
            return [
              { type: "response.output_text.delta", delta: "first answer" },
              { type: "response.completed", response: { id: "resp_1" } },
            ];
          }
          if (responseCreateCount === 2) {
            return [
              {
                type: "response.failed",
                error: { message: "Previous response with id 'resp_1' not found." },
              },
            ];
          }
          return [
            { type: "response.output_text.delta", delta: "second answer" },
            { type: "response.completed", response: { id: "resp_2" } },
          ];
        });
        sockets.push(socket);
        return socket;
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();

    await stream.append(...openAiWsRequestEvents("first"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    const firstCompleted = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    await stream.append(...openAiWsRequestEvents("second"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    const secondCompleted = await stream.waitForEvent({
      afterOffset: firstCompleted.offset,
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(3);
    expect(sockets[0]!.sent[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(sockets[0]!.sent[2]).not.toHaveProperty("previous_response_id");
    expect(sockets[0]!.sent[2]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "first" }),
        expect.objectContaining({ role: "user", content: "second" }),
      ]),
    });
    expect(secondCompleted.payload).toMatchObject({
      provider: "openai-ws",
      result: { status: "success" },
    });
  });

  it("does not answer llm requests addressed to cloudflare-ai", async () => {
    const stream = new MemoryStream();
    let dialed = 0;
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        dialed += 1;
        throw new Error("should not dial");
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: {
        model: "@cf/moonshotai/kimi-k2.7-code",
        provider: "cloudflare-ai",
        requestId: "llm-request:1",
      },
    });
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dialed).toBe(0);
    expect(stream.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["events.iterate.com/openai-ws/llm-request-started"]),
    );
  });

  it("fails openai-ws requests politely when no API key is configured", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: null,
      createResponsesWebSocketClient: async () => {
        throw new Error("should not dial without a key");
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(...openAiWsRequestEvents("hello without a key"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: {
        status: "failure",
        error: { message: expect.stringContaining("OpenAI API key is not configured") },
      },
    });
    expect(stream.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["events.iterate.com/agent/output-added"]),
    );
  });

  it("turns a failed LLM request into an error input and schedules a retry", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append(
      {
        type: "events.iterate.com/agent/llm-provider-selected",
        payload: { ifUnset: true, model: "gpt-5.5", provider: "openai-ws" },
      },
      ...openAiWsRequestEvents("hello"),
    );
    const requested = stream.events.at(-1)!;
    await deliver();
    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestId: requested.offset,
        provider: "openai-ws",
        result: { status: "failure", error: { message: "provider exploded" } },
      },
    });
    await deliver();
    await deliver();

    const errorInput = stream.events.find(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        String(event.payload?.content).includes("Your LLM request failed"),
    );
    expect(errorInput?.payload).toMatchObject({
      content: expect.stringContaining("provider exploded"),
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]!.payload).toMatchObject({ requestId: "llm-request:gen-1" });
    // The retry is the loop talking to itself: it counts as an autonomous turn
    // instead of resetting the circuit breaker the way a real user message does.
    expect(reduceAgentEvents(stream.events)).toMatchObject({ autonomousTurnCount: 1 });
  });

  it("stops auto-retrying after three consecutive failures", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append(
      {
        type: "events.iterate.com/agent/llm-provider-selected",
        payload: { ifUnset: true, model: "gpt-5.5", provider: "openai-ws" },
      },
      ...openAiWsRequestEvents("hello"),
    );
    let requestedOffset = stream.events.at(-1)!.offset;
    await deliver();

    for (let failure = 1; failure <= 3; failure++) {
      await stream.append({
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 10,
          llmRequestId: requestedOffset,
          provider: "openai-ws",
          result: { status: "failure", error: { message: `boom ${failure}` } },
        },
      });
      const completedOffset = stream.events.at(-1)!.offset;
      await deliver(); // completion -> error input appended
      await deliver(); // error input -> retry scheduled (failures 1-2 only)
      if (failure < 3) {
        await deliver(); // scheduled -> agent starts its debounce timer
        // The retry's debounce timer fires llm-request-requested for the new
        // generation. (The seeded request's own timer also fires a duplicate
        // requested event for "llm-request:1" — reduce ignores it, and so
        // must this wait.)
        const requested = await stream.waitForEvent({
          afterOffset: completedOffset,
          predicate: (event) =>
            event.type === "events.iterate.com/agent/llm-request-requested" &&
            (event.payload as any)?.requestId === `llm-request:gen-${failure}`,
          timeoutMs: 2_000,
        });
        requestedOffset = requested.offset;
        await deliver();
      }
    }

    const errorInputs = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        String(event.payload?.content).includes("Your LLM request failed"),
    );
    expect(errorInputs.map((event) => event.payload?.llmRequestPolicy)).toEqual([
      { behaviour: "after-current-request" },
      { behaviour: "after-current-request" },
      { behaviour: "dont-trigger-request" },
    ]);
    expect(errorInputs[2]!.payload).toMatchObject({
      content: expect.stringContaining("automatic retries stopped"),
    });

    // Give a would-be fourth request time to (wrongly) schedule.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await deliver();
    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    expect(scheduled).toHaveLength(3); // seed + two auto-retries, nothing after the cap
  });

  it("resets the consecutive failure counter after a successful request", async () => {
    const failureTurn = (base: number, result: unknown): StreamEventInput[] => [
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 0,
          model: "gpt-5.5",
          provider: "openai-ws",
          requestId: `llm-request:${base}`,
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-5.5", provider: "openai-ws", requestId: `llm-request:${base}` },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: { durationMs: 1, llmRequestId: base + 1, provider: "openai-ws", result },
      },
    ];
    const stream = new MemoryStream();
    await stream.append(
      ...failureTurn(1, { status: "failure", error: { message: "boom" } }),
      ...failureTurn(4, { status: "failure", error: { message: "boom again" } }),
    );
    expect(reduceAgentEvents(stream.events)).toMatchObject({ consecutiveLlmFailures: 2 });

    await stream.append(...failureTurn(7, { status: "success" }));
    expect(reduceAgentEvents(stream.events)).toMatchObject({ consecutiveLlmFailures: 0 });
  });

  it("fails orphaned requests a dead incarnation left behind (recovery sweep)", async () => {
    // Regression for the 2026-07-07 prd email-thread wedge: an incarnation
    // accepted a request (runInBackground advanced the checkpoint), got
    // evicted before completing it, and the agent queued every later input
    // behind the never-completing request forever.
    const stream = new MemoryStream();
    // Incarnation 1: accepted the request and appended started, then died —
    // simulated by writing the events directly, never running a processor.
    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:gen-1" },
    });
    await stream.append({
      type: "events.iterate.com/openai-ws/llm-request-started",
      payload: { llmRequestId: requested!.offset, model: "gpt-test" },
    });

    // Incarnation 2: fresh processor (empty #liveExecutions), catching up.
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        throw new Error("should not dial during orphan recovery");
      },
      readStreamEvents: () => stream.getEvents(),
    });
    // Deliver only the STARTED event (the requested event is before the
    // checkpoint of a caught-up-but-restarted instance in the real incident;
    // any batch works — the sweep reads folded state, not the batch).
    await openAiWs.ingest({
      events: stream.events.filter((event) => event.offset > requested!.offset),
      streamMaxOffset: stream.events.length,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const completions = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-completed",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]!.payload).toMatchObject({
      llmRequestId: requested!.offset,
      provider: "openai-ws",
      result: { status: "failure", error: { message: expect.stringContaining("orphaned") } },
    });

    // A LIVE request in this incarnation is never swept: accept a new request
    // (execution registers synchronously) and deliver the batch — no failure
    // completion appears for it while it runs.
    const [second] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:gen-2" },
    });
    await openAiWs.ingest({
      events: [second!],
      streamMaxOffset: stream.events.length,
    });
    const sweptSecond = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agent/llm-request-completed" &&
        (event.payload as { llmRequestId: number }).llmRequestId === second!.offset &&
        JSON.stringify(event.payload).includes("orphaned"),
    );
    expect(sweptSecond).toHaveLength(0);
  });
});

describe("file attachments in the LLM request", () => {
  const attachment = {
    contentType: "image/png",
    filename: "cat.png",
    path: "/agents/web/demo/abc-cat.png",
    size: 12345,
    url: "https://iterate-files--demo.iterate.app/agents/web/demo/abc-cat.png?exp=1&sig=x",
  };

  it("carries input-added files through to the provider-facing history", async () => {
    const stream = new MemoryStream();
    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "[File attached: cat.png (image/png)]",
          files: [attachment],
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 0,
          model: "gpt-5.5",
          provider: "openai-ws",
          requestId: "llm-request:1",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-5.5", provider: "openai-ws", requestId: "llm-request:1" },
      },
    );

    const body = buildAgentLlmRequestBody({ events: stream.events, llmRequestId: 3 });
    const userMessage = body.messages.find((message) => message.role === "user");
    expect(userMessage).toMatchObject({
      content: "[File attached: cat.png (image/png)]",
      files: [attachment],
    });
  });

  it("reflects sent-message attachments back into model-visible history", async () => {
    const stream = new MemoryStream();
    const processor = new AgentProcessor({ stream });
    await stream.append({
      type: "events.iterate.com/agents/web-message-sent",
      payload: { message: "Here is your cat!", files: [attachment] },
    });
    await deliverNewEvents({ processor, stream, cursors: new Map() });

    const reflected = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(reflected?.payload).toMatchObject({
      content: "The assistant sent this visible web-chat message: Here is your cat!",
      files: [attachment],
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });

    // ...so the next request's history carries the image the agent sent.
    const body = buildAgentLlmRequestBody({ events: stream.events, llmRequestId: 99 });
    const userMessage = body.messages.find((message) => message.role === "user");
    expect(userMessage?.files).toEqual([attachment]);
  });

  it("flattens attachments to actionable hint lines for text-only models", () => {
    const flattened = flattenMessageToText({
      role: "user",
      content: "look at this",
      files: [attachment],
    });
    expect(flattened).toContain("look at this");
    expect(flattened).toContain('itx.files.get("/agents/web/demo/abc-cat.png").bytes()');
    expect(flattened).toContain(attachment.url);
    expect(flattenMessageToText({ role: "user", content: "no files" })).toBe("no files");
  });
});
