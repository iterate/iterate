import { describe, expect, it, vi } from "vitest";
import type { StreamEventInput } from "../streams/schemas.ts";
import {
  AgentProcessor,
  buildAgentCompactionRequestBody,
  buildAgentLlmRequestBody,
  contextWindowTokens,
  flattenMessageToText,
  prepareAgentLlmMessages,
  reduceAgentEvents,
} from "./agent-processor-implementation.ts";
import { normalizeLlmUsage } from "./workers-ai-transport.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  deriveAgentBusy,
} from "./agent-processor-contract.ts";
import { MemoryStream, deliverNewEvents, type ProcessorLike } from "./test-helpers.ts";

function agentRequestEvents(content: string, model = DEFAULT_AGENT_MODEL): StreamEventInput[] {
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
  it("explains the exact codemode shape expected by the itx script runner", () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      "The block must contain a single async arrow function",
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("```ts");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toMatch(/JavaScript|```js(?:\s|$)|\bITX\b/);
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("async (itx) => {");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("await itx.chat.sendMessage(");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain("containing an async function");
    // Tool-call stance: small data-first snippets, parallel fan-out, and the
    // explicit loop-ending rule.
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Promise.all");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("`return;` with no value");
    // Discovery is the prompt's centerpiece: the docs door (search with many
    // words, fetch by name, e2e-tested examples first), not a capability tour
    // or an embedded type surface (the budget test bans the blob).
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("itx.docs.search");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("itx.docs.get");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("TWO SEARCHES, ONE RULE");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("working example scripts");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("itx.mcp.exa.web_search_exa");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("__describe()");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Never tell the user you lack access");
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

  it("renders string results raw — no JSON escaping, no json fence label", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:7", result: 'line one\nline "two"' },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    const content = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/input-added",
    )?.payload?.content as string;
    // The model reads the text itself, not an escaped JSON string of it.
    expect(content).toContain('line one\nline "two"');
    expect(content).not.toContain("\\n");
    expect(content).not.toContain("```json");
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
    // A string result spills as itself — raw text file, no JSON escaping.
    expect(files.map((write) => write.path)).toEqual(["/script-results/agent-output-7.txt"]);
    expect(files[0]!.content).toBe(result);
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
              "```ts",
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
      messages: [
        expect.objectContaining({ role: "system" }),
        { role: "user", content: "hello" },
        // The trailing clock stamp (prompt-cache-safe tail position).
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Current date and time (UTC):"),
        }),
      ],
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
      payload: { content: `Reading the saved output now.\n\n\`\`\`ts\n${script}\n\`\`\`` },
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
    const block = (body: string) => `\`\`\`ts\nasync (itx) => {\n  ${body}\n}\n\`\`\``;
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
      content: expect.stringContaining("```ts block"),
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
    expect(corrective?.payload?.content).not.toContain("```js block");
  });

  it("rejects mixed-language multi-block responses without executing the TypeScript block", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: {
        content: [
          "```ts\nasync (itx) => {\n  return 1;\n}\n```",
          "```python\nprint('planned next step')\n```",
        ].join("\n\n"),
      },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });

    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
      ),
    ).toHaveLength(0);
    expect(
      stream.events.find(
        (event) =>
          event.type === "events.iterate.com/agent/input-added" &&
          typeof event.payload?.content === "string" &&
          event.payload.content.includes("2 fenced code blocks"),
      )?.payload,
    ).toMatchObject({ llmRequestPolicy: { behaviour: "after-current-request" } });
  });

  it("rejects a fenced block that does not start with async, with corrective feedback", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });

    // Models habitually open code with a comment line; the block used to die
    // in total silence (kind "none"), which reads as the platform hanging.
    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: {
        content: "```ts\n// Plan: greet the user first\nasync (itx) => {\n  return 1;\n}\n```",
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
        event.payload.content.includes("STARTS with `async`"),
    );
    expect(corrective?.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "after-current-request" },
    });

    // A fence with a non-TypeScript language tag is the same mistake in a different
    // costume — the extraction regex refuses it, and the system prompt
    // promises rejection-with-feedback, not silence.
    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: { content: "```python\nprint('hello')\n```" },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });
    expect(
      stream.events.filter(
        (event) =>
          event.type === "events.iterate.com/agent/input-added" &&
          typeof event.payload?.content === "string" &&
          event.payload.content.includes("STARTS with `async`"),
      ),
    ).toHaveLength(2);

    // Plain prose with no fence stays a deliberate no-op turn (no feedback).
    await stream.append({
      type: "events.iterate.com/agent/output-added",
      payload: { content: "Just thinking out loud, nothing to run." },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });
    const feedbackEvents = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload?.content === "string" &&
        event.payload.content.includes("STARTS with"),
    );
    expect(feedbackEvents).toHaveLength(2);
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
      "events.iterate.com/agent/status-changed",
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
          return { response: "```ts\nasync (itx) => {}\n```" };
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
            { choices: [{ delta: { content: "```ts\n" } }] },
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

  it("rate-limited failures keep retrying past the generic three-strike cap", async () => {
    const stream = new MemoryStream();
    let attempts = 0;
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          attempts += 1;
          throw new Error("3021: rate limiting: inference request per min rate reached");
        },
      },
      // Milliseconds instead of the production 10s base (see the three-strike
      // test above) so the backoffs run inside the test deadline.
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

    // Drive failing turns until scheduling stops advancing.
    // Idle threshold sits well above one debounce+backoff cycle (~300ms at
    // the shrunken test base) so a pending retry never reads as "stopped".
    const deadline = Date.now() + 10_000;
    let lastScheduledCount = 0;
    let idleRounds = 0;
    while (Date.now() < deadline && idleRounds < 60) {
      await deliverNewEvents({ processor: agent, stream, cursors });
      const scheduledCount = stream.events.filter(
        (event) => event.type === "events.iterate.com/agent/llm-request-scheduled",
      ).length;
      idleRounds = scheduledCount === lastScheduledCount ? idleRounds + 1 : 0;
      lastScheduledCount = scheduledCount;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const errorInputs = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        String(event.payload?.content).includes("Your LLM request failed"),
    );
    // Seven strikes for rate limits (vs three generic): six auto-retries, and
    // only the seventh failure stops the loop.
    expect(errorInputs).toHaveLength(7);
    expect(
      errorInputs.map(
        (event) =>
          (event.payload as { llmRequestPolicy: { behaviour: string } }).llmRequestPolicy.behaviour,
      ),
    ).toEqual([
      ...Array.from({ length: 6 }, () => "after-current-request"),
      "dont-trigger-request",
    ]);
    expect(errorInputs[6]!.payload).toMatchObject({
      content: expect.stringContaining("automatic retries stopped"),
    });
    expect(attempts).toBe(7);
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

    const deadline = Date.now() + 10_000;
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
    // Seed at the plain debounce, first retry on the ladder (8×1), every
    // later retry at the cap (8×6 = 298) instead of the exponential middle
    // rungs — across the rate-limit runway's six retries.
    expect(scheduled.map((event) => event.payload?.debounceMs)).toEqual([
      250,
      258,
      ...Array.from({ length: 5 }, () => 298),
    ]);
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

  it("an interrupt mid-stream feeds the response so far back as model-visible input", async () => {
    const encoder = new TextEncoder();
    let sse!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sse = controller;
      },
    });
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          return body;
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append(...agentRequestEvents("tell me a long story"));
    await deliver(); // reconcile drives the requested obligation; the attempt starts draining
    sse.enqueue(encoder.encode(`data: ${JSON.stringify({ response: "Once upon a time" })}\n\n`));
    // The chunk event is the evidence the accumulator has seen the text.
    await vi.waitFor(() => {
      expect(
        stream.events.some((event) => event.type === "events.iterate.com/agent/llm-response-chunk"),
      ).toBe(true);
    });

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: "stop — different question",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
    await deliver(); // appends the cancel + the response-so-far input

    const partialInput = stream.events.find(
      (event) =>
        event.type === "events.iterate.com/agent/input-added" &&
        typeof event.payload?.content === "string" &&
        event.payload.content.includes("Once upon a time"),
    );
    expect(partialInput?.payload?.content).toContain("Your response so far");
    expect(partialInput?.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    // The partial folds into history, so the NEXT request's prompt carries it.
    const state = reduceAgentEvents(stream.events);
    expect(
      state.history.some(
        (item) =>
          item.role === "user" &&
          typeof item.content === "string" &&
          item.content.includes("Once upon a time"),
      ),
    ).toBe(true);

    // Let the doomed attempt finish: its completion settles as stale, so no
    // output-added doubles up with the partial already in history.
    sse.enqueue(encoder.encode("data: [DONE]\n\n"));
    sse.close();
    await vi.waitFor(() => {
      expect(
        stream.events.some(
          (event) => event.type === "events.iterate.com/agent/llm-request-completed",
        ),
      ).toBe(true);
    });
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/output-added"),
    ).toBe(false);
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

  it("remints attachment URLs immediately before a provider request", async () => {
    const freshUrl =
      "https://iterate-files--demo.iterate.app/agents/web/demo/abc-cat.png?exp=900&ver=v2&sig=fresh";
    const resolveModelFileUrl = vi.fn(async () => freshUrl);

    const [message] = await prepareAgentLlmMessages(
      [{ role: "user", content: "look at this", files: [attachment] }],
      resolveModelFileUrl,
    );

    expect(resolveModelFileUrl).toHaveBeenCalledWith(attachment);
    expect(message).toMatchObject({ role: "user", containsFiles: true });
    expect(message?.content).toContain(freshUrl);
    expect(message?.content).not.toContain(attachment.url);
  });
});

describe("inter-agent mail", () => {
  const mail = (payload: Record<string, unknown>, offset: number) => ({
    type: "events.iterate.com/agents/message-received",
    payload,
    offset,
    createdAt: "2026-07-09T00:00:00.000Z",
    path: "/agents/main/researcher",
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
    expect(entry.content).toContain('itx.agents.get("/agents/main").message(text)');
    expect(entry.content.endsWith("status?")).toBe(true);
    // Agent mail counts against the autonomous turn budget instead of
    // refilling it — the loop breaker bounds agent↔agent ping-pong.
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

describe("token usage and history reset", () => {
  it("reports normalized usage alongside a successful completion, and the fold tallies it", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          return {
            response: "hello!",
            usage: {
              prompt_tokens: 2900,
              completion_tokens: 111,
              total_tokens: 3011,
              prompt_tokens_details: { cached_tokens: 128 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
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
    await deliver(); // message -> schedule
    await deliver(); // schedule starts debounce timer
    await deliver(); // (timer fires the requested event in the background)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(); // requested -> AI call -> output + completion + usage report
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(); // deliver the settled turn (folds the usage tally)

    const report = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/token-usage-reported",
    );
    const requested = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-request-requested",
    );
    expect(report?.payload).toEqual({
      llmRequestOffset: requested!.offset,
      model: DEFAULT_AGENT_MODEL,
      maxContextTokens: 272_000,
      inputTokens: 2900,
      outputTokens: 111,
      cachedInputTokens: 128,
      reasoningOutputTokens: 2,
    });

    const state = reduceAgentEvents(stream.events);
    expect(state.tokenUsage).toEqual({
      totalInputTokens: 2900,
      totalOutputTokens: 111,
      totalCachedInputTokens: 128,
      totalReasoningOutputTokens: 2,
    });
  });

  it("skips the report when the vendor sent no parseable usage, and on failures", async () => {
    const stream = new MemoryStream();
    let fail = false;
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          if (fail) throw new Error("vendor exploded");
          return { response: "no usage here" };
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "hello", from: { kind: "user", origin: "web" } },
    });
    await deliver(); // message -> schedule
    await deliver(); // schedule starts debounce timer
    await deliver(); // (timer fires the requested event in the background)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(); // requested -> AI call -> output + completion + usage report
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(); // deliver the settled turn (folds the usage tally)

    fail = true;
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "again", from: { kind: "user", origin: "web" } },
    });
    // Pump the failed turn through its retry ladder: completion -> error
    // input -> retry schedule -> requested -> failed completion, twice over.
    for (let i = 0; i < 6; i += 1) await deliver();

    const completions = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/llm-request-completed",
    );
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/token-usage-reported"),
    ).toBe(false);
  });

  it("normalizes both vendor usage dialects and rejects shapes without totals", () => {
    // OpenAI Responses dialect.
    expect(
      normalizeLlmUsage({
        input_tokens: 29_295,
        output_tokens: 111,
        input_tokens_details: { cached_tokens: 28_416 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ).toEqual({
      inputTokens: 29_295,
      outputTokens: 111,
      cachedInputTokens: 28_416,
      reasoningOutputTokens: 0,
    });
    // Workers-AI-native totals-only.
    expect(normalizeLlmUsage({ prompt_tokens: 4096, completion_tokens: 118 })).toEqual({
      inputTokens: 4096,
      outputTokens: 118,
    });
    expect(normalizeLlmUsage(undefined)).toBeUndefined();
    expect(normalizeLlmUsage({ total_tokens: 5000 })).toBeUndefined();
  });

  it("longest-prefix matches context windows, with a conservative default", () => {
    expect(contextWindowTokens("openai/gpt-5.6-sol")).toBe(272_000);
    expect(contextWindowTokens("openai/gpt-5.6-sol-2026-07-13")).toBe(272_000);
    expect(contextWindowTokens("openai/gpt-5.5")).toBe(272_000);
    expect(contextWindowTokens("openai/gpt-5.5-2026-01-15")).toBe(272_000);
    expect(contextWindowTokens("@cf/qwen/qwen3-coder-plus")).toBe(128_000);
  });

  it("history-reset replaces history and system prompt wholesale; the next request body shrinks", () => {
    const event = (input: { type: string; payload: Record<string, unknown> }, offset: number) => ({
      createdAt: "2026-07-09T00:00:00.000Z",
      path: "/agents/main",
      offset,
      ...input,
    });
    const before = [
      event(
        {
          type: "events.iterate.com/agents/message-received",
          payload: { content: "long question one", from: { kind: "user", origin: "web" } },
        },
        1,
      ),
      event(
        {
          type: "events.iterate.com/agent/output-added",
          payload: { content: "long answer one" },
        },
        2,
      ),
      event(
        {
          type: "events.iterate.com/agents/message-received",
          payload: { content: "long question two", from: { kind: "user", origin: "web" } },
        },
        3,
      ),
    ];
    const reset = event(
      {
        type: "events.iterate.com/agent/history-reset",
        payload: {
          systemPrompt: "You are terse.",
          history: [{ role: "user", content: "[Compacted summary: user asks long questions.]" }],
          reason: "compaction@3",
        },
      },
      4,
    );
    const after = event(
      {
        type: "events.iterate.com/agents/message-received",
        payload: { content: "and now?", from: { kind: "user", origin: "web" } },
      },
      5,
    );

    const state = reduceAgentEvents([...before, reset, after]);
    expect(state.systemPrompt).toBe("You are terse.");
    expect(state.history).toEqual([
      { role: "user", content: "[Compacted summary: user asks long questions.]" },
      { role: "user", content: "and now?" },
    ]);

    const body = buildAgentLlmRequestBody({
      events: [...before, reset, after],
      llmRequestOffset: 6,
    });
    expect(body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "[Compacted summary: user asks long questions.]" },
      { role: "user", content: "and now?" },
    ]);
  });

  it("a context-length vendor error turns into a completed failure the reset can then clear", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      llmRetryBackoffBaseMs: 1,
      ai: {
        async run(_model, body) {
          const chars = JSON.stringify(body).length;
          if (chars > 5_000) {
            throw new Error("3020: prompt too long: context length exceeded");
          }
          return { response: "ok", usage: { prompt_tokens: 40, completion_tokens: 3 } };
        },
      },
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "x".repeat(8_000), from: { kind: "user", origin: "web" } },
    });

    // The oversized turn fails and auto-retries (1ms backoff) until the
    // consecutive-failure cap; drain the whole ladder so no late retry can
    // race the reset below and succeed against the compacted history.
    const failures = () =>
      stream.events.filter(
        (event) =>
          event.type === "events.iterate.com/agent/llm-request-completed" &&
          (event.payload?.result as { status?: string } | undefined)?.status === "failure",
      );
    for (let i = 0; i < 200 && failures().length < 3; i += 1) {
      await deliver();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(failures().length).toBe(3);
    expect(failures()[0]!.payload?.result).toMatchObject({
      status: "failure",
      error: { message: expect.stringContaining("context length exceeded") },
    });
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/token-usage-reported"),
    ).toBe(false);

    // Userspace compaction appends a reset; the next turn's body is small
    // (the reset also replaced the huge system prompt) and the same vendor
    // now accepts it.
    await stream.append({
      type: "events.iterate.com/agent/history-reset",
      payload: {
        systemPrompt: "You are terse.",
        history: [{ role: "user", content: "[Compacted summary.]" }],
        reason: "compaction@1",
      },
    });
    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "short follow-up", from: { kind: "user", origin: "web" } },
    });
    const successes = () =>
      stream.events.filter(
        (event) =>
          event.type === "events.iterate.com/agent/llm-request-completed" &&
          (event.payload?.result as { status?: string } | undefined)?.status === "success",
      );
    for (let i = 0; i < 200 && successes().length === 0; i += 1) {
      await deliver();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await deliver();

    expect(successes()).toHaveLength(1);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/agent/token-usage-reported",
      ),
    ).toHaveLength(1);
  });

  it("an over-threshold usage report triggers compaction: summary via the agent's model, history replaced", async () => {
    const stream = new MemoryStream();
    const aiCalls: { model: string; messages: { role: string; content: string }[] }[] = [];
    const makeAgent = () =>
      new AgentProcessor({
        stream,
        path: stream.path,
        projectId: null,
        ai: {
          async run(model, body) {
            const { messages } = body as { messages: { role: string; content: string }[] };
            aiCalls.push({ model, messages });
            // The summarize instruction rides as the LAST message, behind the
            // conversation exactly as normal turns send it (prompt-cache
            // prefix reuse) — so that is where compaction is recognizable.
            if (messages.at(-1)!.content.includes("compacting this AI agent conversation")) {
              return { response: "The user likes teal and is building STICKYMEETING." };
            }
            // A turn that ran at over half of GPT-5.6 Sol's 272k operating window.
            return {
              response: "noted!",
              usage: { prompt_tokens: 140_000, completion_tokens: 500 },
            };
          },
        },
      });
    const agent = makeAgent();
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "remember: I like teal", from: { kind: "user", origin: "web" } },
    });
    await deliver(); // message -> schedule
    await deliver(); // schedule starts debounce timer
    await deliver(); // (timer fires the requested event in the background)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(); // requested -> AI call -> output + completion + usage report
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    // Delivering the usage report trips the compaction trigger. Stop the
    // world: the delivery itself blocks until the summary lands, so the reset
    // is already in the journal when deliver() returns.
    await deliver();
    const reset = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/history-reset",
    )!;
    expect(reset).toBeDefined();

    const compactionCalls = () =>
      aiCalls.filter((call) =>
        call.messages.at(-1)!.content.includes("compacting this AI agent conversation"),
      );
    expect(compactionCalls()).toHaveLength(1);
    // The summary sees the whole conversation and runs on the agent's model.
    expect(compactionCalls()[0]!.model).toBe(DEFAULT_AGENT_MODEL);
    // The compaction request extends the normal turn's request byte for byte
    // (same system prompt, same history messages) so the provider's prompt
    // cache — an exact-prefix match — covers the biggest request an agent
    // ever makes. Divergence only at the tail: the turn's trailing clock
    // message versus the summarize instruction.
    const turnRequest = aiCalls[0]!;
    const compactionRequest = compactionCalls()[0]!;
    expect(compactionRequest.messages.slice(0, turnRequest.messages.length - 1)).toEqual(
      turnRequest.messages.slice(0, -1),
    );
    expect(compactionRequest.messages).toMatchObject([
      { role: "system", content: DEFAULT_AGENT_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining("remember: I like teal") },
      { role: "assistant", content: expect.stringContaining("noted!") },
      { role: "system", content: expect.stringContaining("output only the summary") },
    ]);
    expect(reset.payload).toMatchObject({
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
      history: [
        {
          role: "user",
          content: expect.stringContaining("The user likes teal and is building STICKYMEETING."),
        },
      ],
      reason: expect.stringMatching(/^compaction@\d+: ~140500 tokens > 136000$/),
    });

    // The fold's model-visible history is now just the summary.
    const state = reduceAgentEvents(stream.events);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.content).toContain("[Earlier conversation history was compacted.");

    // A fresh incarnation redelivering the whole journal must not summarize
    // again: the durable guard sees this trigger's reset and skips before the
    // AI call.
    const revived = makeAgent();
    await deliverNewEvents({ processor: revived, stream, cursors: new Map<object, number>() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(compactionCalls()).toHaveLength(1);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/history-reset"),
    ).toHaveLength(1);
  });

  it("buildAgentCompactionRequestBody extends the conversation verbatim with the instruction last", () => {
    const state = {
      systemPrompt: "You are terse.",
      history: [
        { role: "user" as const, content: "remember: I like teal" },
        { role: "assistant" as const, content: "noted!" },
      ],
    };
    const body = buildAgentCompactionRequestBody(state);
    // The cached-prefix property: everything but the trailing instruction is
    // the conversation exactly as buildAgentLlmRequestBody sends it.
    expect(body.messages.slice(0, -1)).toEqual([
      { role: "system", content: "You are terse." },
      ...state.history,
    ]);
    expect(body.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("compacting this AI agent conversation"),
    });
  });

  it("compaction rides the BYOK transport with the conversation's prompt cache key and journals the cache split", async () => {
    const stream = new MemoryStream();
    const encoder = new TextEncoder();
    const sse = (frames: unknown[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    const gatewayBodies: { prompt_cache_key?: string; messages: { content: string }[] }[] = [];
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        run: async () => {
          throw new Error("unified lane must not be dialed when BYOK transport is configured");
        },
        gateway: () => ({
          run: async ({ query }: { query: unknown }) => {
            const body = query as (typeof gatewayBodies)[number];
            gatewayBodies.push(body);
            const isCompaction = body.messages
              .at(-1)!
              .content.includes("compacting this AI agent conversation");
            return new Response(
              sse(
                isCompaction
                  ? [
                      {
                        choices: [{ delta: { content: "Summary.", role: "assistant" }, index: 0 }],
                      },
                      {
                        choices: [],
                        usage: {
                          prompt_tokens: 141_000,
                          completion_tokens: 20,
                          prompt_tokens_details: { cached_tokens: 140_800 },
                        },
                      },
                    ]
                  : [
                      { choices: [{ delta: { content: "noted!", role: "assistant" }, index: 0 }] },
                      { choices: [], usage: { prompt_tokens: 140_000, completion_tokens: 500 } },
                    ],
              ),
            );
          },
        }),
      },
      cloudflareAiGatewayTransport: () => ({
        kind: "byok",
        gatewayId: "default",
        openaiApiKey: "sk-test",
        openaiPromptCacheKey: "prj_x:/agents/main",
      }),
    });
    const cursors = new Map<object, number>();
    const deliver = () => deliverNewEvents({ processor: agent, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/message-received",
      payload: { content: "remember: I like teal", from: { kind: "user", origin: "web" } },
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

    const reset = stream.events.find(
      (event) => event.type === "events.iterate.com/agent/history-reset",
    )!;
    expect(reset).toBeDefined();
    // Both the turn and the summary rode the gateway with the SAME cache key,
    // so the summary lands on the shard already holding the turn's prefix.
    expect(gatewayBodies).toHaveLength(2);
    expect(gatewayBodies.map((body) => body.prompt_cache_key)).toEqual([
      "prj_x:/agents/main",
      "prj_x:/agents/main",
    ]);
    // The journaled reason carries the measured cache split — the live
    // evidence that prefix reuse worked (or didn't) for every compaction.
    expect(reset.payload?.reason).toMatch(
      /; summary llm usage: input=141000 cached=140800 output=20$/,
    );
  });

  it("an under-threshold usage report does not compact", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          throw new Error("no AI call expected");
        },
      },
    });
    await stream.append({
      type: "events.iterate.com/agent/token-usage-reported",
      payload: {
        llmRequestOffset: 1,
        model: "openai/gpt-5.5",
        maxContextTokens: 272_000,
        inputTokens: 10_000,
        outputTokens: 200,
      },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/agent/history-reset"),
    ).toBe(false);
  });
});

describe("busy/idle activity announcements", () => {
  const userMessage = () => ({
    type: "events.iterate.com/agents/message-received" as const,
    payload: { content: "hi", from: { kind: "user" as const, origin: "web" } },
  });
  const announcements = (stream: MemoryStream) =>
    stream.events
      .filter((event) => event.type === "events.iterate.com/agent/status-changed")
      .map((event) => event.payload);

  it("announces busy immediately when a trigger queues a turn", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({ stream, path: stream.path, projectId: null });
    const [received] = await stream.append(userMessage());
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });

    expect(announcements(stream)).toEqual([{ busy: true, sinceOffset: received!.offset }]);
  });

  it("announces a debounced idle once the turn settles, then goes quiet", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      statusIdleDebounceMs: 0,
      ai: {
        async run() {
          return { response: "All done." };
        },
      },
    });
    const cursors = new Map<object, number>();
    await stream.append(userMessage());
    await vi.waitFor(
      async () => {
        await deliverNewEvents({ processor: agent, stream, cursors });
        expect(announcements(stream)).toEqual([
          { busy: true, sinceOffset: expect.any(Number) },
          { busy: false, sinceOffset: expect.any(Number) },
        ]);
      },
      { timeout: 5_000 },
    );

    // The announcement loop terminates: absorbing the idle announcement into
    // the fold announces nothing further.
    await deliverNewEvents({ processor: agent, stream, cursors });
    const journalLength = stream.events.length;
    await deliverNewEvents({ processor: agent, stream, cursors });
    expect(stream.events.length).toBe(journalLength);
  });

  it("new work inside the idle debounce window leaves the blip out of the journal", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      statusIdleDebounceMs: 60_000,
      ai: {
        async run() {
          return { response: "Done." };
        },
      },
    });
    const cursors = new Map<object, number>();
    await stream.append(userMessage());
    await vi.waitFor(
      async () => {
        await deliverNewEvents({ processor: agent, stream, cursors });
        expect(
          stream.events.some(
            (event) => event.type === "events.iterate.com/agent/llm-request-completed",
          ),
        ).toBe(true);
      },
      { timeout: 5_000 },
    );
    // Absorb the completion: the idle flip is folded and its debounce armed.
    await deliverNewEvents({ processor: agent, stream, cursors });
    expect(announcements(stream)).toEqual([{ busy: true, sinceOffset: expect.any(Number) }]);

    // A second message arrives inside the window: derived activity is busy
    // again — equal to what is already announced — so the pending idle is
    // superseded and the journal never records the blip.
    await stream.append(userMessage());
    await deliverNewEvents({ processor: agent, stream, cursors });
    expect(announcements(stream)).toEqual([{ busy: true, sinceOffset: expect.any(Number) }]);
  });

  it("a revived incarnation announces a past-due idle flip immediately", async () => {
    // A live run settles a turn, but dies before its idle debounce fires.
    const stream = new MemoryStream();
    const live = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      statusIdleDebounceMs: 60_000,
      ai: {
        async run() {
          return { response: "Done." };
        },
      },
    });
    const cursors = new Map<object, number>();
    await stream.append(userMessage());
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
    await deliverNewEvents({ processor: live, stream, cursors });
    expect(announcements(stream)).toEqual([{ busy: true, sinceOffset: expect.any(Number) }]);

    // The revival folds the journal, finds the idle flip past due, and
    // announces it inline — without dialing the AI for the settled request.
    const revived = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      statusIdleDebounceMs: 60_000,
      now: () => Date.now() + 120_000,
      ai: {
        async run(): Promise<never> {
          throw new Error("revival must not dial the AI binding");
        },
      },
    });
    await revived.ingest({
      events: stream.events,
      streamMaxOffset: stream.events.at(-1)!.offset,
    });
    expect(announcements(stream).at(-1)).toEqual({ busy: false, sinceOffset: expect.any(Number) });
  });

  it("a replayed settled turn with no prior announcements stays silent", async () => {
    // A journal that folds trigger-through-completion to idle in ONE at-head
    // page with nothing announced yet (a pre-announcement journal refolded
    // after a contract deploy, or a synthetically seeded lifecycle) announces
    // NEITHER busy nor idle: no surface ever painted anything, so there is
    // nothing to clear — and an idle append here would fire once per
    // historical agent journal on the first refold after a deploy.
    const stream = new MemoryStream();
    await stream.append(
      userMessage(),
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: { debounceMs: 0, model: "gpt-test", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        // The key the replayed scheduled event's re-armed debounce timer will
        // re-derive, so its append dedupes into this seeded event.
        idempotencyKey: "agent/llm-request-requested@2",
        payload: { model: "gpt-test", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: { durationMs: 10, llmRequestOffset: 3, result: { status: "success" } },
      },
    );
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      statusIdleDebounceMs: 0,
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map<object, number>() });
    // Let the replayed scheduled event's re-armed timer fire and dedupe.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(announcements(stream)).toEqual([]);
    expect(deriveAgentBusy(agent.state)).toBe(false);
  });

  it("the fold ignores a stale idle announcement that lost its race", () => {
    const statusEvent = (payload: Record<string, unknown>, offset: number) => ({
      type: "events.iterate.com/agent/status-changed",
      payload,
      offset,
      createdAt: "2026-07-09T00:00:00.000Z",
      path: "/agents/test",
    });
    const state = reduceAgentEvents([
      statusEvent({ busy: true, sinceOffset: 4 }, 5),
      // The debounce timer's idle append landed after newer busy work; its
      // older sinceOffset must fold to nothing.
      statusEvent({ busy: false, sinceOffset: 2 }, 6),
    ]);
    expect(state.announcedStatus).toEqual({ busy: true, sinceOffset: 4 });
  });

  it("derives script-turn hand-offs as busy, with only one-append idle gaps", () => {
    const at = (offset: number, type: string, payload: Record<string, unknown>) => ({
      type,
      payload,
      offset,
      createdAt: "2026-07-09T00:00:00.000Z",
      path: "/agents/test",
    });
    const journal = [
      at(1, "events.iterate.com/agents/message-received", {
        content: "run it",
        from: { kind: "user", origin: "web" },
      }),
      at(2, "events.iterate.com/agent/llm-request-scheduled", {
        debounceMs: 0,
        model: "gpt-test",
        requestId: "llm-request:gen-0",
      }),
      at(3, "events.iterate.com/agent/llm-request-requested", {
        model: "gpt-test",
        requestId: "llm-request:gen-0",
      }),
      at(4, "events.iterate.com/agent/llm-request-completed", {
        durationMs: 10,
        llmRequestOffset: 3,
        result: { status: "success" },
      }),
    ];
    // Trigger through completion: busy, no interruptions.
    expect(deriveAgentBusy(reduceAgentEvents(journal.slice(0, 1)))).toBe(true);
    expect(deriveAgentBusy(reduceAgentEvents(journal.slice(0, 3)))).toBe(true);
    // The one-append gap: the completion folds before the extracted script
    // request lands. This is the blip the idle announcement debounce covers.
    expect(deriveAgentBusy(reduceAgentEvents(journal))).toBe(false);

    // The script request arrives: busy again.
    const withScript = [
      ...journal,
      at(5, "events.iterate.com/capability-host/script-execution-requested", {
        code: "async () => {}",
        executionId: "script-5",
      }),
    ];
    expect(deriveAgentBusy(reduceAgentEvents(withScript))).toBe(true);

    // Script completion → rendered result input: the same one-append gap,
    // then the re-queued loop turns the activity back to thinking.
    const nextTurn = [
      ...withScript,
      at(6, "events.iterate.com/capability-host/script-execution-completed", {
        executionId: "script-5",
        result: null,
      }),
      at(7, "events.iterate.com/agent/input-added", {
        content: "script result",
        llmRequestPolicy: { behaviour: "after-current-request" },
      }),
    ];
    expect(deriveAgentBusy(reduceAgentEvents(nextTurn))).toBe(true);
    // Every flip is stamped with the event that caused it.
    expect(reduceAgentEvents(nextTurn).status).toMatchObject({ busy: true, sinceOffset: 7 });
  });
});
