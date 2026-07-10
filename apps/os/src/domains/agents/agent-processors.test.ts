import { describe, expect, it, vi } from "vitest";
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
import { MemoryStream, deliverNewEvents, type ProcessorLike } from "./test-helpers.ts";

function agentRequestEvents(content: string, model = "openai/gpt-5.5"): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/agent/input-added",
      payload: { content, llmRequestPolicy: { behaviour: "after-current-request" } },
    },
    {
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: {
        debounceMs: 0,
        model,
        requestId: "llm-request:1",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model, requestId: "llm-request:1" },
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
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
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
      path: stream.path,
      projectId: null,
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

    // The scratch dir self-ignores so a workspace git.commit never ships
    // spills to the config repo's main.
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
      path: stream.path,
      projectId: null,
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
      path: stream.path,
      projectId: null,
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
      path: stream.path,
      projectId: null,
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

  it("feeds a thrown script error back as input", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
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
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
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
      path: stream.path,
      projectId: null,
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
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
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
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "hello", from: { kind: "user", origin: "web" } },
    });
    await deliver();
    await deliver();
    await deliver();
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver();
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver();

    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/agents/message-received",
        "events.iterate.com/agent/llm-request-scheduled",
        "events.iterate.com/agent/llm-request-requested",
        "events.iterate.com/agent/llm-request-started",
        "events.iterate.com/agent/output-added",
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
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

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

  it("rejects a multi-block response with corrective feedback instead of executing the first block", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

    // Mirrors a prd incident (agents/web/2026-07-10t05-13-04-967z): the model
    // planned a whole workflow as four sequential scripts in one response.
    // Only the first used to run — silently; the model believed all four did.
    const block = (body: string) => `\`\`\`js\nasync (itx) => {\n  ${body}\n}\n\`\`\``;
    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: {
        content: `${block("return 1;")}\n\n${block("return 2;")}\n\n${block("return 3;")}`,
      },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    const requested = stream.events.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(requested).toHaveLength(0);
    const corrective = stream.events.find(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload?.content === "string" &&
        event.payload.content.includes("3 fenced code blocks"),
    );
    expect(corrective?.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
  });

  it("treats MCP-origin messages like any other inbound user message", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: {
        content: "how many agents does this project have?",
        from: { kind: "user", origin: "mcp" },
      },
    });
    await deliver(agent);
    await deliver(agent);

    // The message folds straight into history (no input-added reflection).
    expect(stream.events.map((event) => event.type)).toEqual([
      "events.iterate.com/agents/message-received",
      "events.iterate.com/agent/llm-request-scheduled",
    ]);
    expect(stream.events[0]!.payload).toMatchObject({
      content: "how many agents does this project have?",
    });
  });

  it("coalesces multiple triggering inputs delivered in one batch into one LLM request", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

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
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

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
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
    const cursors = new Map<object, number>();

    await stream.append(
      {
        type: "events.iterate.com/agents/message-received",
        payload: { content: "first ask from MCP", from: { kind: "user", origin: "mcp" } },
      },
      {
        type: "events.iterate.com/agents/message-received",
        payload: { content: "second ask from MCP", from: { kind: "user", origin: "mcp" } },
      },
    );

    // Both messages fold straight into history in one batch; the settle pass
    // derives exactly one scheduled request for the pair.
    await deliverNewEvents({ processor: agent, stream, cursors });
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
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run(_model, body) {
          aiCalls.push(body);
          resolveFirstCall();
          return { response: "```js\nasync (itx) => {}\n```" };
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    // First user message — triggers llm-request-scheduled (with debounce)
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "message one", from: { kind: "user", origin: "web" } },
    });
    await deliver();
    await deliver();
    await deliver();

    // Second user message arrives before debounce fires — queued as pending
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "message two", from: { kind: "user", origin: "web" } },
    });
    await deliver();

    // Wait for the LLM call to complete (both messages included in it)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver();
    await firstCallInFlight;
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver();

    // Give the processor time to fire a spurious second request if the bug is present
    await new Promise((resolve) => setTimeout(resolve, 100));
    await deliver();

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
          model: "openai/gpt-5.5",
          requestId: "llm-request:1",
        },
      },
    );
    // Simulate a checkpoint written after the scheduled event but before the timer fired
    const stuckState = AgentProcessorContract.stateSchema.parse({
      history: [{ role: "user", content: "hello" }],
      currentRequest: { phase: "scheduled", requestId: "llm-request:1", scheduledOffset: 2 },
      llmConfigConfigured: true,
    });
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      readState: async () => ({ offset: 2, state: stuckState }),
    });
    // New event arrives after restart — triggers recovery
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "second message", from: { kind: "user", origin: "web" } },
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
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
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
          model: "openai/gpt-5.5",
          requestId: "llm-request:1",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: "openai/gpt-5.5",
          requestId: "llm-request:1",
        },
      },
    );

    await deliverNewEvents({
      processor: agent,
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

  it("fails LLM requests politely when no AI binding is configured", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
    });

    await stream.append(...agentRequestEvents("hello without ai"));
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      result: {
        status: "failure",
        error: { message: expect.stringContaining("no AI binding") },
      },
    });
    expect(stream.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["events.iterate.com/agent/output-added"]),
    );
  });

  it("turns a failed LLM request into an error input and schedules a retry", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          throw new Error("provider exploded");
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "hello",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    await deliver(); // input -> schedule
    await deliver(); // schedule starts debounce timer
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(); // requested -> AI fails -> completion
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(); // completion -> error input
    await deliver(); // error input -> retry schedule

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

  it("stops auto-retrying after three consecutive failures, with backoff between retries", async () => {
    const stream = new MemoryStream();
    let boom = 0;
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          boom += 1;
          throw new Error(`boom ${boom}`);
        },
      },
      // Milliseconds instead of the production 10s base, so the retry loop
      // (which waits out each backoff for real) runs inside the test deadline.
      llmRetryBackoffBaseMs: 8,
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    let afterOffset = 0;
    async function driveFailingTurn(failure: number) {
      // Drain until a new completion lands past afterOffset.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await deliver();
        const completed = stream.events.find(
          (event) =>
            event.offset > afterOffset &&
            event.type === "events.iterate.com/agent/llm-request-completed",
        );
        if (completed !== undefined) {
          expect(completed.payload).toMatchObject({
            result: { status: "failure", error: { message: `boom ${failure}` } },
          });
          afterOffset = completed.offset;
          await deliver(); // completion -> error input
          await deliver(); // error input -> maybe retry schedule
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for failure #${failure}`);
    }

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "hello",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });

    await driveFailingTurn(1);
    await driveFailingTurn(2);
    await driveFailingTurn(3);

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
    // Retries space out exponentially (base × 2^(n-1) rides the debounce);
    // the 2026-07-09 prd incident burned all retries in ~1s of instant 8008s.
    expect(scheduled.map((event) => event.payload?.debounceMs)).toEqual([250, 258, 266]);
  });

  it("repeated rate-limited failures jump the retry backoff to the ladder cap", async () => {
    // The quota refills on a time window: the first retry stays cheap (the
    // failure may have been the tail of a hot minute), but once it confirms
    // the window is still hot, the next retry waits the full cap (base × 6)
    // instead of burning the last attempt inside the same minute.
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          throw new Error("3021: rate limiting: inference request per min rate reached");
        },
      },
      llmRetryBackoffBaseMs: 8,
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "hello",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await deliverNewEvents({ processor: agent, stream, cursors });
      const stopped = stream.events.some(
        (event) =>
          event.type === "events.iterate.com/agent/input-added" &&
          String(event.payload?.content).includes("automatic retries stopped"),
      );
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const scheduled = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    );
    // Seed at the plain debounce, first retry on the ladder (8×1), second at
    // the cap (8×6) instead of the exponential middle rung (266).
    expect(scheduled.map((event) => event.payload?.debounceMs)).toEqual([250, 258, 298]);
  });

  it("resets the consecutive failure counter after a successful request", async () => {
    const failureTurn = (base: number, result: unknown): StreamEventInput[] => [
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 0,
          model: "gpt-5.5",
          requestId: `llm-request:${base}`,
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-5.5", requestId: `llm-request:${base}` },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: { durationMs: 1, llmRequestOffset: base + 1, result },
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

  it("resets the consecutive failure counter on a fresh user message, not on loop inputs", async () => {
    // Regression for the 2026-07-09 prd Telegram outage tail: a provider blip
    // burned the retry budget, and the user's NEXT message ("hi?") inherited
    // the stale counter — one attempt, then "retries stopped". A user trigger
    // is a fresh turn and must get the full retry budget.
    const failure = (base: number): StreamEventInput[] => [
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { debounceMs: 0, model: "gpt-5.5", requestId: `llm-request:${base}` },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-5.5", requestId: `llm-request:${base}` },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 1,
          llmRequestOffset: base + 1,
          result: { status: "failure", error: { message: "boom" } },
        },
      },
    ];
    const stream = new MemoryStream();
    await stream.append(...failure(1), ...failure(4));
    expect(reduceAgentEvents(stream.events)).toMatchObject({ consecutiveLlmFailures: 2 });

    // A loop-generated input (a rendered failure notice) keeps the counter.
    await stream.append({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-llm-failure@/agents/x:5",
      payload: {
        content: "Your LLM request failed",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    expect(reduceAgentEvents(stream.events)).toMatchObject({ consecutiveLlmFailures: 2 });

    // A user-triggered input resets it.
    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: { content: "hi?", llmRequestPolicy: { behaviour: "after-current-request" } },
    });
    expect(reduceAgentEvents(stream.events)).toMatchObject({ consecutiveLlmFailures: 0 });
  });

  it("cancels in-flight requests a dead incarnation left behind (recovery sweep)", async () => {
    // Regression for the 2026-07-07 prd email-thread wedge: an incarnation
    // accepted a request (runInBackground advanced the checkpoint), got
    // evicted before completing it, and the agent queued every later input
    // behind the never-completing request forever. The in-flight attempt is
    // cancelled (durable-object-crashed), not failed as a completed LLM call.
    const stream = new MemoryStream();
    // Incarnation 1: accepted the request and appended started, then died —
    // simulated by writing the events directly, never running a processor.
    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:gen-1" },
    });
    await stream.append({
      type: "events.iterate.com/agent/llm-request-started",
      payload: { llmRequestOffset: requested!.offset, model: "gpt-test" },
    });

    // Incarnation 2: fresh processor (empty #liveLlmExecutions), catching up.
    // Hang forever if a live execution is wrongly started for the orphan.
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          await new Promise(() => {});
          return { response: "unreachable" };
        },
      },
    });
    // At-head fold of the dead incarnation's events: obligation is `started`
    // with nobody live → reconciler cancels without re-driving AI.
    await agent.ingest({
      events: stream.events,
      streamMaxOffset: stream.events.length,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cancellations = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-cancelled",
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]!.payload).toMatchObject({
      phase: "requested",
      reason: "durable-object-crashed",
      llmRequestOffset: requested!.offset,
    });
    expect(
      stream.events.some(
        (event) => event.type === "events.iterate.com/agent/llm-request-completed",
      ),
    ).toBe(false);

    // A LIVE request in this incarnation is never swept: accept a new request
    // (execution registers synchronously) and deliver the batch — no crash
    // cancel appears for it while it runs.
    const [second] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:gen-2" },
    });
    await agent.ingest({
      events: [second!],
      streamMaxOffset: stream.events.length,
    });
    const sweptSecond = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agent/llm-request-cancelled" &&
        (event.payload as { llmRequestOffset: number }).llmRequestOffset === second!.offset,
    );
    expect(sweptSecond).toHaveLength(0);
  });
});

describe("interrupt and stray-request hygiene", () => {
  it("an interrupt during the debounce window disarms the timer; the cancelled request never fires", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          return { response: "answered the second message" };
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "first thought",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    await deliver(); // reconcile schedules gen-0
    await deliver(); // processEvent arms the gen-0 debounce timer
    const scheduled = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
    )!;

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "wait, scrap that",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
    await deliver(); // appends the scheduled-phase cancel
    await deliver(); // processes the cancel: disarms the timer, schedules gen-1

    // Past the original debounce: the cancelled request must NOT have fired.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      stream.events.find(
        (event) => event.idempotencyKey === `agent/llm-request-requested@${scheduled.offset}`,
      ),
    ).toBeUndefined();

    // The interrupting input's own turn still proceeds (a fresh generation).
    await vi.waitFor(async () => {
      await deliver();
      const requested = stream.events.filter(
        (event) => event.type === "events.iterate.com/agent/llm-request-requested",
      );
      expect(requested).toHaveLength(1);
      expect((requested[0]!.payload as { requestId: string }).requestId).not.toBe(
        (scheduled.payload as { requestId: string }).requestId,
      );
    });
  });

  it("settles a stray non-current requested obligation without dialing the AI binding", async () => {
    const stream = new MemoryStream();
    let dials = 0;
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          dials += 1;
          return { response: "the real answer" };
        },
      },
    });
    // A current request mid-lifecycle plus a stray raw-appended requested
    // event: driving the stray would run a parallel LLM turn nobody asked for.
    const [, current, stray] = await stream.append(
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { debounceMs: 60_000, model: "m", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "m", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "m", requestId: "llm-request:stray" },
      },
    );
    await agent.ingest({ events: stream.events, streamMaxOffset: stray!.offset });

    await vi.waitFor(() => {
      const strayCompletion = stream.events.find(
        (event) =>
          event.type === "events.iterate.com/agent/llm-request-completed" &&
          (event.payload as { llmRequestOffset: number }).llmRequestOffset === stray!.offset,
      );
      expect(strayCompletion?.payload).toMatchObject({
        result: {
          status: "failure",
          error: { message: expect.stringContaining("not the agent's current request") },
        },
      });
    });
    await vi.waitFor(() => {
      const currentCompletion = stream.events.find(
        (event) =>
          event.type === "events.iterate.com/agent/llm-request-completed" &&
          (event.payload as { llmRequestOffset: number }).llmRequestOffset === current!.offset,
      );
      expect(currentCompletion?.payload).toMatchObject({ result: { status: "success" } });
    });
    expect(dials).toBe(1);
  });
});

describe("refold safety", () => {
  // The doctrine's refold test (docs/writing-stream-processors.md): every
  // processor whose process* hooks touch a vendor must prove that replaying a
  // SETTLED journal into a fresh instance re-executes nothing. This is what
  // catches consumed-idempotency-key and staleness-guard regressions.
  it("refold: replaying the settled journal dials no AI and appends nothing new", async () => {
    // Live flow to a settled turn: user message → scheduled → requested →
    // started → output → completed, folded by a live processor as it goes.
    const stream = new MemoryStream();
    const live = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          return { response: "All done — nothing else to do." };
        },
      },
    });
    const cursors = new Map<object, number>();
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "hi", from: { kind: "user", origin: "web" } },
    });
    await vi.waitFor(
      async () => {
        await deliverNewEvents({ processor: live, stream, cursors });
        expect(
          stream.events.some(
            (event) => event.type === "events.iterate.com/agent/llm-request-completed",
          ),
        ).toBe(true);
      },
      { timeout: 5_000 },
    );
    // Absorb the completion into the live fold and let the journal go quiet.
    await deliverNewEvents({ processor: live, stream, cursors });
    expect(live.state.llmRequests).toEqual({});
    expect(live.state.currentRequest).toBeNull();
    const journalLength = stream.events.length;

    // A fresh incarnation refolds the WHOLE journal (a discarded checkpoint —
    // the normal aftermath of deploying a state-shape change). It must
    // re-execute NOTHING: a dangerous fake proves zero AI dials, the journal
    // gains zero events, and the refolded state equals the live instance's.
    const refolded = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run(): Promise<never> {
          throw new Error("refold must not dial the AI binding");
        },
      },
    });
    await refolded.ingest({
      events: stream.events,
      streamMaxOffset: stream.events.at(-1)!.offset,
    });
    // The replayed llm-request-scheduled re-arms a debounce timer; wait past
    // it to prove the re-derived requested event dedups into the original
    // instead of journaling anew.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stream.events.length).toBe(journalLength);
    expect(refolded.state).toEqual(live.state);
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
          requestId: "llm-request:1",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-5.5", requestId: "llm-request:1" },
      },
    );

    const body = buildAgentLlmRequestBody({ events: stream.events, llmRequestOffset: 3 });
    const userMessage = body.messages.find((message) => message.role === "user");
    expect(userMessage).toMatchObject({
      content: "[File attached: cat.png (image/png)]",
      files: [attachment],
    });
  });

  it("reflects sent-message attachments back into model-visible history", async () => {
    const stream = new MemoryStream();
    const processor = new AgentProcessor({ stream, path: stream.path, projectId: null });
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
    const body = buildAgentLlmRequestBody({ events: stream.events, llmRequestOffset: 99 });
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

describe("subagents in reduced state", () => {
  const announced = (childPath: string, offset: number) => ({
    type: "events.iterate.com/stream/child-stream-created",
    payload: { childPath },
    offset,
    createdAt: "2026-07-09T00:00:00.000Z",
    path: "/agents/main",
  });

  it("folds immediate subagent births from child-stream-created announcements", () => {
    const state = reduceAgentEvents([
      announced("/agents/main/subagents/researcher", 1),
      // A grandchild announces to every ancestor too — it belongs to the
      // subagent's own fold, not this one.
      announced("/agents/main/subagents/researcher/subagents/helper", 2),
      // Duplicate announcements dedupe.
      announced("/agents/main/subagents/researcher", 3),
      // A non-subagent child stream is not a subagent.
      announced("/agents/main/notes", 4),
    ]);
    expect(state.subagents).toMatchObject([
      { path: "/agents/main/subagents/researcher", spawnedAt: "2026-07-09T00:00:00.000Z" },
    ]);
  });
});

describe("inter-agent mail", () => {
  const mail = (payload: Record<string, unknown>, offset: number) => ({
    type: "events.iterate.com/agents/message-received",
    payload,
    offset,
    createdAt: "2026-07-09T00:00:00.000Z",
    path: "/agents/main/subagents/researcher",
  });

  it("folds agent mail into history with the sender named and the reply door spelled out, as an autonomous trigger", () => {
    const state = reduceAgentEvents([
      mail({ content: "status?", from: { kind: "agent", path: "/agents/main" } }, 1),
    ]);
    expect(state.history).toHaveLength(1);
    const entry = state.history[0]!;
    expect(entry.role).toBe("user");
    // Child-agent-ness rides on the message: the label names the sender and
    // tells the recipient how to reply (the sender never sees this web chat).
    expect(entry.content).toContain("Message from agent /agents/main");
    expect(entry.content).toContain('itx.agents.get("/agents/main")');
    expect(entry.content).toContain("sender.message(text)");
    expect(entry.content.endsWith("status?")).toBe(true);
    // Agent mail counts against the autonomous turn budget instead of
    // refilling it — the loop breaker bounds parent↔subagent ping-pong.
    expect(state.pendingTriggerSource).toBe("agent-loop");
    expect(state.pendingTriggerOffset).toBe(1);
  });

  it("human messages refill the autonomous budget", () => {
    const state = reduceAgentEvents([
      mail({ content: "hi", from: { kind: "user", origin: "web" } }, 1),
    ]);
    expect(state.history).toMatchObject([{ role: "user", content: "hi" }]);
    expect(state.pendingTriggerSource).toBe("user");
    expect(state.autonomousTurnCount).toBe(0);
  });

  it("dont-trigger-request records the message without waking the loop", () => {
    const state = reduceAgentEvents([
      mail(
        {
          content: "webhook without a mention",
          from: { kind: "github", login: "someone" },
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
        1,
      ),
    ]);
    expect(state.history).toHaveLength(1);
    expect(state.pendingTriggerOffset).toBeNull();
  });
});
