// The agent keeper WITHOUT any interpretation loop, driven through the
// memory harness: turn loop
// and LLM request run exactly as in the classic processor, but NOTHING
// platform-side interprets assistant output — that is userland's job (the
// project's config worker appends the consequences itself). These tests pin
// the whole userland loop by playing the worker's part by hand: the platform
// half (turns, mirror rules) and the userland half (script request, prose
// delivery, status, settlement rendering) meet on the public event
// vocabulary.

import { expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { AgentProcessor } from "./agent-processor.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AGENT_BIRTH_FINALIZE_DEADLINE_MS } from "./agent-turn-loop.ts";
import type { WorkersAiMessage } from "./workers-ai-transport.ts";

const CONTEXT_ADDED = "events.iterate.com/agents/context-added";
const SCRIPT_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";

it("runs a full turn but interprets nothing: even a perfect ```ts script is left alone", async () => {
  const h = makeKeeperHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("run something")],
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

it("slash commands are inert without interpretation: no execution, no LLM turn (userland's job)", async () => {
  const h = makeKeeperHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("/example describe-project {}")],
    ["advanceTime", 60_000],
  );
  expect(h.events(SCRIPT_REQUESTED)).toHaveLength(0);
  expect(h.llm.calls).toHaveLength(0);
});

it("the full userland loop: worker-appended consequences drive scripts, chat, and the next turn", async () => {
  const h = makeKeeperHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("look into it")],
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
  const h = makeKeeperHarness();
  await h.play([
    "append",
    ...NEW_AGENT_EVENTS,
    { type: WEB_MESSAGE_SENT, payload: { message: "sent by a script" } },
  ]);
  expect(h.state().contextItems.at(-1)).toMatchObject({
    payload: {
      role: "assistant",
      content: "The assistant sent this visible web-chat message: sent by a script",
    },
  });
});

it("holds the first turn until the birth is finalized; the finalize releases it", async () => {
  const h = makeKeeperHarness();
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: CONTEXT_ADDED,
        payload: { role: "system", key: "agent/system-prompt", content: "prompt" },
      },
      userMessage("anyone home?"),
    ],
    // Well within the readiness deadline: the trigger stays HELD — no
    // intent, no LLM call, and crucially no answer on a half-authored
    // personality.
    ["advanceTime", 5_000],
  );
  expect(h.llm.calls).toHaveLength(0);
  expect(h.events("events.iterate.com/agent/llm-request-requested")).toHaveLength(0);
  expect(h.state().pendingLlmRequestTrigger).not.toBeNull();

  // The config worker finalizes → the held trigger runs on the authored
  // personality, and no degraded-start fact ever lands.
  await h.play(
    ["append", { type: "events.iterate.com/agent/birth-finalized", payload: {} }],
    ["advanceTime", 10_000],
  );
  expect(h.llm.calls).toHaveLength(1);
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(0);

  await h.play(() => h.llm.respond("hello!"));
  expect(h.state().contextItems.at(-1)).toMatchObject({
    payload: { role: "assistant", content: "hello!" },
  });
});

it("degraded start: a missed readiness deadline appends the visible timed-out fact, the default personality, and finalize", async () => {
  const h = makeKeeperHarness();
  await h.play([
    "append",
    { type: "events.iterate.com/agent/created", payload: {} },
    userMessage("hello?"),
  ]);
  expect(h.llm.calls).toHaveLength(0);

  // The deadline is armed at the HELD TRIGGER (the message), not at birth.
  await h.play(["advanceTime", AGENT_BIRTH_FINALIZE_DEADLINE_MS + 60_000]);
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(1);
  const prompt = h.state().contextItems.find((item) => item.payload.key === "agent/system-prompt");
  expect(prompt).toBeDefined(); // the platform-default personality landed
  expect(h.state().birthFinalizedAtOffset).toBeDefined();
  // …and the held turn ran on it.
  expect(h.llm.calls).toHaveLength(1);
});

it("an idle unborn agent waits forever for free: no deadline arms before the first held trigger", async () => {
  const h = makeKeeperHarness();
  await h.play(
    ["append", { type: "events.iterate.com/agent/created", payload: {} }],
    ["advanceTime", 24 * 60 * 60_000],
  );
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(0);
  expect(h.llm.calls).toHaveLength(0);
});

// -----------------------------------------------------------------------------
// Harness: the generic step harness plus a minimal scripted LLM (mirrors
// agent-processor.test.ts).
// -----------------------------------------------------------------------------

type AgentEventInput = ConsumedInput<AgentProcessorContract>;

const NEW_AGENT_EVENTS = [
  { type: "events.iterate.com/agent/created", payload: {} },
  {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "test-model" } } },
  },
  {
    type: CONTEXT_ADDED,
    payload: {
      role: "system",
      key: "agent/system-prompt",
      content: "You are a helpful keeper test agent.",
    },
  },
  { type: "events.iterate.com/agent/birth-finalized", payload: {} },
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

function makeKeeperHarness() {
  const llm = makeScriptedLlm();
  const harness = makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) => new AgentProcessor({ ...deps, callLlm: llm.transport }),
    path: "/agents/keeper-test",
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
