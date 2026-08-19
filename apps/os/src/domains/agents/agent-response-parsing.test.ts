// The enableDefaultLlmResponseParsing flag, driven through the memory
// harness. OFF: turn loop and LLM request run exactly as ever, but NOTHING
// platform-side interprets assistant output — that is userland's job (the
// project's config worker appends the consequences itself). These tests pin
// the whole userland loop by playing the worker's part by hand: the platform
// half (turns, mirror rules) and the userland half (script request, prose
// delivery, status, settlement rendering) meet on the public event
// vocabulary. Also here: the deprecated `driver` shim and the retired
// "agent-headless" stub.

import { expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import {
  HeadlessAgentProcessor,
  type HeadlessAgentProcessorContract,
} from "./agent-headless-processor.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";
import type { WorkersAiMessage } from "./workers-ai-transport.ts";

const CONTEXT_ADDED = "events.iterate.com/agents/context-added";
const SCRIPT_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";

it("runs a full turn but interprets nothing: even a perfect ```ts script is left alone", async () => {
  const h = makeAgentHarness();
  await h.play(
    ["append", ...PARSING_OFF_AGENT_EVENTS, userMessage("run something")],
    ["advanceTime", 10_000],
  );
  expect(h.llm.calls).toHaveLength(1);
  await h.play(() => h.llm.respond("```ts\nasync (itx) => 1\n```"), ["advanceTime", 10_000]);

  // The response landed as raw assistant context and the request settled…
  expect(h.state().openRequest).toBeNull();
  expect(h.state().contextItems.at(-1)).toMatchObject({
    payload: { role: "assistant", content: "```ts\nasync (itx) => 1\n```" },
  });
  // …and that is ALL: no script request, no corrective feedback, no chat
  // message. Interpretation belongs to userland.
  expect(h.events(SCRIPT_REQUESTED)).toHaveLength(0);
  expect(h.events(WEB_MESSAGE_SENT)).toHaveLength(0);
  expect(h.state().contextItems.filter((item) => item.payload.role === "developer")).toHaveLength(
    0,
  );
});

it("slash commands are inert with parsing off: no execution, no LLM turn (userland's job)", async () => {
  const h = makeAgentHarness();
  await h.play(
    ["append", ...PARSING_OFF_AGENT_EVENTS, userMessage("/example describe-project {}")],
    ["advanceTime", 60_000],
  );
  expect(h.events(SCRIPT_REQUESTED)).toHaveLength(0);
  expect(h.llm.calls).toHaveLength(0);
});

it("the full userland loop: worker-appended consequences drive scripts, chat, and the next turn", async () => {
  const h = makeAgentHarness();
  await h.play(
    ["append", ...PARSING_OFF_AGENT_EVENTS, userMessage("look into it")],
    ["advanceTime", 10_000],
  );
  const requestOffset = h.state().openRequest!.requestedAtOffset;
  await h.play(() =>
    h.llm.respond(
      'On it!\n<codemode status="Checking">\nreturn await itx.doWhatever()\n</codemode>',
    ),
  );
  const assistantOffset = h.state().contextItems.at(-1)!.offset;

  // Now play the config worker's part — the same appends the platform's
  // codemode component would have made, through the public vocabulary.
  await h.play([
    "append",
    {
      type: "events.iterate.com/agent/summary-updated",
      payload: { activity: "Checking" },
    },
    {
      type: SCRIPT_REQUESTED,
      payload: {
        code: "async (itx) => {\nreturn await itx.doWhatever()\n}",
        executionId: `agent-output:${assistantOffset}`,
        expiresAt: Date.parse("2030-01-01T00:00:00Z"),
      },
    },
    {
      type: WEB_MESSAGE_SENT,
      payload: { message: "On it!", llmRequestOffset: requestOffset },
    },
  ]);

  // Status folded; extracted prose NOT mirrored back into history (the raw
  // assistant text is already there).
  expect(h.state().summary).toMatchObject({ activity: "Checking" });
  expect(
    h
      .state()
      .contextItems.filter((item) =>
        item.payload.content.startsWith("The assistant sent this visible web-chat message:"),
      ),
  ).toHaveLength(0);

  // The script settles; the worker renders the result as developer context
  // with after-current-request — which is what drives the next turn.
  await h.play(
    [
      "append",
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: {
          executionId: `agent-output:${assistantOffset}`,
          settlement: { status: "succeeded", result: { abc: 123 } },
        },
      },
      {
        type: CONTEXT_ADDED,
        payload: {
          role: "developer",
          content: 'Your script returned:\n```json\n{ "abc": 123 }\n```',
          actor: { type: "script", executionId: `agent-output:${assistantOffset}` },
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    ],
    ["advanceTime", 10_000],
  );
  expect(h.llm.calls).toHaveLength(2);
  const prompt = h.llm.calls[1]!.messages.map((message) => message.content).join("\n");
  expect(prompt).toContain('"abc": 123');
});

it("a plain sendMessage (no llmRequestOffset) still mirrors into assistant history", async () => {
  const h = makeAgentHarness();
  await h.play([
    "append",
    ...PARSING_OFF_AGENT_EVENTS,
    { type: WEB_MESSAGE_SENT, payload: { message: "sent by a script" } },
  ]);
  expect(h.state().contextItems.at(-1)).toMatchObject({
    payload: {
      role: "assistant",
      content: "The assistant sent this visible web-chat message: sent by a script",
    },
  });
});

it("the deprecated driver knob maps onto the parsing flag; an explicit flag wins", async () => {
  const h = makeAgentHarness();
  await h.play(["append", { type: "events.iterate.com/agent/created", payload: {} }]);
  expect(h.state().config.enableDefaultLlmResponseParsing).toBe(true);

  // Old seeded worker code appends driver flips; they land as flag flips.
  await h.play([
    "append",
    {
      type: "events.iterate.com/agent/configured",
      payload: { config: { driver: "agent-headless" } },
    },
  ]);
  expect(h.state().config.enableDefaultLlmResponseParsing).toBe(false);
  await h.play([
    "append",
    { type: "events.iterate.com/agent/configured", payload: { config: { driver: "agent" } } },
  ]);
  expect(h.state().config.enableDefaultLlmResponseParsing).toBe(true);

  // Both in one payload: the explicit flag wins over the deprecated knob.
  await h.play([
    "append",
    {
      type: "events.iterate.com/agent/configured",
      payload: { config: { driver: "agent", enableDefaultLlmResponseParsing: false } },
    },
  ]);
  expect(h.state().config.enableDefaultLlmResponseParsing).toBe(false);
});

it("the retired agent-headless stub accepts deliveries and does nothing", async () => {
  // Streams that opted into the old headless handover still carry an
  // "agent-headless" subscription; the stub exists so those deliveries
  // resolve instead of erroring. The unified processor (their "agent"
  // subscription) does the actual work.
  const llm = makeScriptedLlm();
  const h = makeProcessorHarness<HeadlessAgentProcessorContract>({
    createProcessor: (deps) => new HeadlessAgentProcessor({ ...deps, callLlm: llm.transport }),
    path: "/agents/legacy-headless",
  });
  await h.play(
    ["append", ...PARSING_OFF_AGENT_EVENTS, userMessage("anyone home?")],
    ["advanceTime", 60_000],
  );
  expect(llm.calls).toHaveLength(0);
  expect(h.events("events.iterate.com/agent/llm-request-requested")).toHaveLength(0);
});

// -----------------------------------------------------------------------------
// Harness: the generic step harness plus a minimal scripted LLM (mirrors
// agent-processor.test.ts).
// -----------------------------------------------------------------------------

type AgentEventInput = ConsumedInput<AgentProcessorContract>;

const PARSING_OFF_AGENT_EVENTS = [
  { type: "events.iterate.com/agent/created", payload: {} },
  {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "test-model" }, enableDefaultLlmResponseParsing: false } },
  },
  {
    type: CONTEXT_ADDED,
    payload: {
      role: "system",
      key: "agent/system-prompt",
      content: "You are a helpful test agent whose output nothing platform-side parses.",
    },
  },
] satisfies AgentEventInput[];

function userMessage(content: string): AgentEventInput {
  return {
    type: CONTEXT_ADDED,
    payload: {
      role: "user",
      content,
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

function makeAgentHarness() {
  const llm = makeScriptedLlm();
  const harness = makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) => new AgentProcessor({ ...deps, callLlm: llm.transport }),
    path: "/agents/parsing-off-test",
  });
  return { ...harness, llm };
}

function makeScriptedLlm() {
  const calls: {
    model: string;
    messages: WorkersAiMessage[];
    signal: AbortSignal;
    resolve: (result: { text: string }) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    calls,
    respond(text: string) {
      calls.at(-1)!.resolve({ text });
    },
    transport: (args: { model: string; messages: WorkersAiMessage[]; signal: AbortSignal }) =>
      new Promise<{ text: string }>((resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(new Error("aborted")));
        calls.push({ ...args, resolve, reject });
      }),
  };
}
