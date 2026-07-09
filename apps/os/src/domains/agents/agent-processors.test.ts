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

function openAiWsRequestEvents(content: string, requestId = "llm-request:1"): StreamEventInput[] {
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
        requestId,
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-5.5", provider: "openai-ws", requestId },
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
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("CONFIG REPO EDITS");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      'const repo = itx.repos.get(vars.repoPath ?? "/repos/config")',
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

  it("spills an oversized script result to a workspace file and references it", async () => {
    const stream = new MemoryStream();
    const writes: { content: string; path: string }[] = [];
    const agent = new AgentProcessor({
      stream,
      writeWorkspaceFile: async (input) => {
        writes.push(input);
      },
    });

    const result = { items: "x".repeat(50_000) };
    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    // The scratch dir self-ignores so workspace snapshot publishes never
    // commit spills to the workspace branch.
    expect(writes.map((write) => write.path)).toEqual([
      "/script-results/.gitignore",
      "/script-results/agent-output-7.json",
    ]);
    expect(writes[0]!.content).toBe("*\n");
    expect(writes[1]!.content).toBe(JSON.stringify(result, null, 2));

    const input = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    const content = input?.payload?.content as string;
    expect(content).toContain("Your script returned");
    expect(content).toContain('saved in your workspace at "/script-results/agent-output-7.json"');
    expect(content).toContain('itx.workspace.readFile("/script-results/agent-output-7.json")');
    // The inline preview stays bounded: head slice, not the whole result.
    expect(content.length).toBeLessThan(32_000);
  });

  it("spills a multi-megabyte result as ONE file (R2 handles the size)", async () => {
    const stream = new MemoryStream();
    const writes: { content: string; path: string }[] = [];
    const agent = new AgentProcessor({
      stream,
      writeWorkspaceFile: async (input) => {
        writes.push(input);
      },
    });

    // Well past the workspace inline threshold — the workspace spills the
    // file to R2 itself, so no splitting happens here.
    const result = "x".repeat(9_200_000);
    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    const files = writes.filter((write) => !write.path.endsWith(".gitignore"));
    expect(files.map((write) => write.path)).toEqual(["/script-results/agent-output-7.json"]);
    expect(files[0]!.content).toBe(JSON.stringify(result, null, 2));
  });

  it("falls back to inline truncation when the workspace spill fails", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      writeWorkspaceFile: async () => {
        throw new Error("workspace unavailable");
      },
    });

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result: { items: "x".repeat(50_000) } },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    const content = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    )?.payload?.content as string;
    expect(content).toMatch(/truncated \(\d+ chars total — return less/);
    expect(content).not.toContain("saved in your workspace");
  });

  it("does not spill small script results", async () => {
    const stream = new MemoryStream();
    const writes: { content: string; path: string }[] = [];
    const agent = new AgentProcessor({
      stream,
      writeWorkspaceFile: async (input) => {
        writes.push(input);
      },
    });

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result: { ok: true } },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    expect(writes).toEqual([]);
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/input-added"),
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

  it("extracts the whole script when a string literal embeds a markdown fence", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream });

    // Mirrors a prd incident (agents/web/2026-07-09t14-21-45-359z): a chat
    // message formatted as markdown puts ``` inside the script's string
    // literal; extraction must not cut the script at that inner fence.
    const script = [
      "async (itx) => {",
      '  await itx.chat.sendMessage("Tail:\\n```text\\n" + "0123456789".slice(-4) + "\\n```");',
      "}",
    ].join("\n");
    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: { content: `Reading the saved output now.\n\n\`\`\`js\n${script}\n\`\`\`` },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    const requested = stream.events.find(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(requested?.payload?.code).toBe(script);
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

    // The first chunk is BEHIND the head (input two exists past it), so the
    // at-head gate defers scheduling entirely; the second chunk reaches the
    // head and derives exactly one scheduled event for both inputs. The
    // generation-keyed idempotency remains the second line of defense for
    // batches that raced to the same derivation.
    await agent.ingest({ events: stream.events.slice(0, 1), streamMaxOffset: 2 });
    await agent.ingest({ events: stream.events.slice(1, 2), streamMaxOffset: 2 });

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
    // The terminal chunk's usage normalizes into token-usage-reported (kimi's
    // window from the provider's model table; no cache/reasoning breakdown).
    const report = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/token-usage-reported"],
      timeoutMs: 2_000,
    });
    expect(report.payload).toMatchObject({
      provider: "cloudflare-ai",
      model: "@cf/moonshotai/kimi-k2.7-code",
      maxContextTokens: 256_000,
      inputTokens: 34,
      outputTokens: 12,
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
            // The real API sends incomplete_details as an explicit null on
            // completed responses; a schema that rejects null here makes the
            // consumer skip the terminal frame and wait forever.
            response: { id: "resp_1", incomplete_details: null, usage: { total_tokens: 7 } },
          },
        ]);
        sockets.push(socket);
        return socket;
      },
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

  it("fails an openai-ws request that ends incomplete instead of keeping partial output", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () =>
        fakeResponsesWebSocket(() => [
          { type: "response.output_text.delta", delta: '```js\nasync (itx) => { const s = "cut' },
          {
            type: "response.incomplete",
            response: {
              id: "resp_1",
              incomplete_details: { reason: "max_output_tokens" },
              status: "incomplete",
              usage: { total_tokens: 9 },
            },
          },
        ]),
    });

    await stream.append(...openAiWsRequestEvents("hello over ws"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: {
        status: "failure",
        error: { message: expect.stringContaining("max_output_tokens") },
      },
    });
    // A truncated response must never become an assistant turn — executing a
    // prefix of a script is worse than failing the request and retrying.
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/output-added"),
    ).toBe(false);
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
    });
    // Deliver the dead incarnation's events; the fold shows the obligation at
    // `started` and the reconciler settles it WITHOUT starting an attempt
    // (started + nobody live = orphaned, never re-driven — hence the throwing
    // websocket factory above proving no dial happens).
    await openAiWs.ingest({
      events: stream.events,
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

describe("context window compaction mechanics (openai-ws)", () => {
  // OpenAI's Responses API rejects a request whose input exceeds the model's
  // context window with a context_length_exceeded error instead of answering;
  // the fake socket mirrors that contract, and under-window requests succeed
  // with OpenAI-shaped usage. Compaction itself is USERSPACE policy (the
  // CompactionProcessor in the project repo template). These tests pin down
  // the platform's half of that loop: normalized token-usage-reported after
  // every successful turn, and history-reset folding into a smaller request.
  const FAKE_CONTEXT_WINDOW_TOKENS = 200_000;
  // The ~4-chars-per-token heuristic; plenty for a threshold mock.
  const estimateRequestTokens = (request: unknown) => Math.ceil(JSON.stringify(request).length / 4);

  function contextWindowLimitedSocket(): FakeResponsesWebSocket {
    return fakeResponsesWebSocket((request) => {
      if (estimateRequestTokens(request) > FAKE_CONTEXT_WINDOW_TOKENS) {
        return [
          {
            type: "error",
            error: {
              code: "context_length_exceeded",
              message:
                "Your input exceeds the context window of this model. Please adjust your input and try again.",
            },
          },
        ];
      }
      return [
        { type: "response.output_text.delta", delta: "```js\nasync (itx) => {}\n```" },
        {
          type: "response.completed",
          response: {
            id: "resp_fits",
            usage: {
              input_tokens: estimateRequestTokens(request),
              input_tokens_details: { cached_tokens: 128, cache_write_tokens: 0 },
              output_tokens: 9,
              output_tokens_details: { reasoning_tokens: 2 },
              total_tokens: estimateRequestTokens(request) + 9,
            },
          },
        },
      ];
    });
  }

  // ~100 conversation turns of ~6k chars per message ≈ 1.2M chars ≈ 300k
  // estimated tokens — well past the fake 200k window.
  function overWindowHistory(): StreamEventInput[] {
    const filler = "All work and no compaction makes the context window overflow. ".repeat(96);
    return Array.from({ length: 100 }).flatMap((_, turn): StreamEventInput[] => [
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: `[turn ${turn}] ${filler}`,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/output-added",
        payload: { content: `[ack ${turn}] ${filler}` },
      },
    ]);
  }

  it("fails an over-window request with the provider's context error, reporting no usage", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => contextWindowLimitedSocket(),
    });

    await stream.append(...overWindowHistory());
    await stream.append(...openAiWsRequestEvents("are you still with me?"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });

    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: {
        status: "failure",
        error: { message: expect.stringContaining("context window") },
      },
    });
    // A failed request has no usage — so no report. Userspace compaction is
    // proactive: it triggers off the reports of the SUCCESSFUL turns leading
    // up to the window, before overflow ever happens.
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/token-usage-reported"),
    ).toBe(false);
  });

  it("a history-reset (what userspace compaction appends) shrinks the next request under the window", async () => {
    const stream = new MemoryStream();
    const socket = contextWindowLimitedSocket();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => socket,
    });
    const cursors = new Map<object, number>();

    await stream.append(...overWindowHistory());
    await stream.append(...openAiWsRequestEvents("are you still with me?"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    const firstCompleted = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    expect(firstCompleted.payload).toMatchObject({ result: { status: "failure" } });

    // What the template's CompactionProcessor appends after summarizing.
    await stream.append({
      type: "events.iterate.com/agent/history-reset",
      idempotencyKey: "compaction/history-reset@42",
      payload: {
        systemPrompt: "You are a helpful assistant.",
        history: [
          {
            role: "user",
            content:
              "[Earlier conversation history was compacted. Summary:]\n\nA hundred turns of overflow filler.",
          },
        ],
        reason: "compaction@42: over half the window",
      },
    });
    await stream.append(...openAiWsRequestEvents("second ask, after the reset", "llm-request:2"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    const secondCompleted = await stream.waitForEvent({
      afterOffset: firstCompleted.offset,
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(secondCompleted.payload).toMatchObject({
      provider: "openai-ws",
      result: { status: "success" },
    });
    // The reset folded into the request body: under the window, summary
    // included, giant turns gone, and the live question still present.
    const finalRequest = socket.sent.at(-1);
    expect(estimateRequestTokens(finalRequest)).toBeLessThanOrEqual(FAKE_CONTEXT_WINDOW_TOKENS);
    const finalRequestJson = JSON.stringify(finalRequest);
    expect(finalRequestJson).toContain("history was compacted");
    expect(finalRequestJson).toContain("second ask, after the reset");
    expect(finalRequestJson).not.toContain("[turn 0]");
    // And the agent got a usable turn out of it.
    const output = stream.events.find(
      (event) =>
        event.type === "events.iterate.com/agent/output-added" &&
        (event.payload as { llmRequestId?: number }).llmRequestId !== undefined,
    );
    expect(output?.payload).toMatchObject({ content: "```js\nasync (itx) => {}\n```" });
  });

  it("drops provider-side continuation after a history-reset", async () => {
    // The Responses continuation lane (previous_response_id) references the
    // provider's stored conversation — the PRE-reset history. Continuing it
    // after a reset would resurrect everything compaction just removed, so
    // the request after a reset must send the full (compacted) input.
    const stream = new MemoryStream();
    const socket = contextWindowLimitedSocket();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => socket,
    });
    const cursors = new Map<object, number>();

    // Turn 1 succeeds and mints a provider-side continuation id.
    await stream.append(...openAiWsRequestEvents("first ask"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    const firstCompleted = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    expect(firstCompleted.payload).toMatchObject({ result: { status: "success" } });

    // Userspace compaction replaces the history...
    await stream.append({
      type: "events.iterate.com/agent/history-reset",
      idempotencyKey: "compaction/history-reset@99",
      payload: {
        systemPrompt: "You are a helpful assistant.",
        history: [{ role: "user", content: "[Earlier history was compacted. Summary:] ..." }],
      },
    });
    // ...so turn 2 must NOT continue the pre-reset provider chain.
    await stream.append(...openAiWsRequestEvents("second ask", "llm-request:2"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
    await stream.waitForEvent({
      afterOffset: firstCompleted.offset,
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).not.toHaveProperty("previous_response_id");
    expect(socket.sent[1]).not.toHaveProperty("previous_response_id");
    const secondRequest = JSON.stringify(socket.sent[1]);
    expect(secondRequest).toContain("history was compacted");
    expect(secondRequest).toContain("second ask");
  });

  it("normalizes provider usage into token-usage-reported and tallies it in agent state", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => contextWindowLimitedSocket(),
    });

    await stream.append(...openAiWsRequestEvents("hello, small context"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    const report = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/token-usage-reported"],
      timeoutMs: 2_000,
    });
    const usage = report.payload as { inputTokens: number };
    expect(report.payload).toMatchObject({
      provider: "openai-ws",
      model: "gpt-5.5",
      maxContextTokens: 272_000,
      outputTokens: 9,
      cachedInputTokens: 128,
      reasoningOutputTokens: 2,
    });
    expect(usage.inputTokens).toBeGreaterThan(0);

    // The agent fold tallies lifetime totals from the normalized report.
    expect(reduceAgentEvents(stream.events).tokenUsage).toEqual({
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: 9,
      totalCachedInputTokens: 128,
      totalReasoningOutputTokens: 2,
    });
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
