// The restart-idea boundary, pinned as two executable facts about the
// degraded start (a config worker that misses the birth-readiness deadline):
//
// (a) keyed supersession HEALS the stream in place — a late worker's
//     personality lands as newer occurrences of the same logical slots, and
//     every later turn runs on it; no conflicts, no manual repair.
// (b) what it cannot heal: a turn that already ran on the wrong (default)
//     personality is model-visible history and cannot be un-said — the
//     standing, executable argument for a future logical/physical stream
//     path split (deliberately NOT built now; see the birth-refactor task's
//     out-of-scope list). The assertions DEMONSTRATE the pollution.

import { expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-defaults.ts";
import { AgentProcessor } from "./agent-processor.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AGENT_BIRTH_FINALIZE_DEADLINE_MS } from "./agent-turn-loop.ts";
import type { WorkersAiMessage } from "./workers-ai-transport.ts";

const WORKER_PROMPT = "You are the codemode-tag agent. Respond in <codemode> tags.";

it("the readiness deadline survives incarnation death: an eviction mid-hold still degrades and dispatches", async () => {
  // The deadline sleeper is a droppable runInBackground attempt, and the
  // held trigger is the LAST event that ever arrives on its own — so the
  // recovery keepalive (the keeper registers with recovery) is what makes
  // the deadline durable: the alarm parked ahead of the in-flight sleep
  // revives a fresh incarnation, whose at-head pass re-arms the deadline
  // off the SAME held trigger's atMs (deterministic — already past, so it
  // fires immediately). Without that, an eviction inside the ~10s window
  // would hold the agent forever with no later delivery to save it.
  const h = makeHarness();
  await h.play(
    ["append", { type: "events.iterate.com/agent/created", payload: {} }, userMessage("hello?")],
    ["advanceTime", 2_000], // inside the window: held, sleeper parked
  );
  expect(h.llm.calls).toHaveLength(0);
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(0);

  // Eviction: the incarnation dies with the parked sleeper closure.
  h.crash();

  await h.play(["advanceTime", AGENT_BIRTH_FINALIZE_DEADLINE_MS + 60_000]);
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(1);
  expect(h.state().birthFinalizedAtOffset).toBeDefined();
  expect(h.llm.calls).toHaveLength(1); // the held turn dispatched on the default personality
});

it("(a) a late worker's personality supersedes the degraded start in place — later turns run on it", async () => {
  const h = makeHarness();
  // A message arrives while the worker is down; the deadline expires and the
  // platform degrades: timed-out fact + default personality + finalize, and
  // the held turn runs on the default prompt.
  await h.play(
    ["append", { type: "events.iterate.com/agent/created", payload: {} }, userMessage("hello?")],
    ["advanceTime", AGENT_BIRTH_FINALIZE_DEADLINE_MS + 60_000],
  );
  expect(h.events("events.iterate.com/agent/birth-timed-out")).toHaveLength(1);
  expect(h.llm.calls).toHaveLength(1);
  await h.play(() => h.llm.respond("hi (answered on the default personality)"));

  // The worker comes back and runs its ordinary birth job: the SAME default
  // events (identical content-hash keys → pure dedupe, no conflict), its own
  // prompt in the same keyed slot, and its own finalize (a harmless later
  // occurrence). Nothing about the degraded start has to be special-cased.
  await h.play([
    "append",
    {
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: "codemode-tag/system-prompt:abc:birth",
      payload: { role: "system", key: "agent/system-prompt", content: WORKER_PROMPT },
    },
    {
      type: "events.iterate.com/agent/birth-finalized",
      idempotencyKey: "codemode-tag/birth-finalized:v1",
      payload: {},
    },
  ]);

  // Healed in place: the logical prompt slot's newest occurrence is the
  // worker's, and the next turn's rendered prompt carries it.
  const promptOccurrences = h
    .state()
    .contextItems.filter((item) => item.payload.key === "agent/system-prompt");
  expect(promptOccurrences.at(-1)).toMatchObject({ payload: { content: WORKER_PROMPT } });

  await h.play(["append", userMessage("and now?")], ["advanceTime", 10_000]);
  expect(h.llm.calls).toHaveLength(2);
  const prompt = h.llm.calls[1]!.messages.map((message) => message.content).join("\n");
  expect(prompt).toContain(WORKER_PROMPT);
});

it("(b) a wrong-personality turn already in model-visible history cannot be un-said", async () => {
  const h = makeHarness();
  await h.play(
    ["append", { type: "events.iterate.com/agent/created", payload: {} }, userMessage("hello?")],
    ["advanceTime", AGENT_BIRTH_FINALIZE_DEADLINE_MS + 60_000],
  );
  await h.play(() => h.llm.respond("plain-prose answer, not in the worker's format"));
  // The late worker supersedes the personality (spec a)…
  await h.play([
    "append",
    {
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: "codemode-tag/system-prompt:abc:birth",
      payload: { role: "system", key: "agent/system-prompt", content: WORKER_PROMPT },
    },
  ]);

  // …but the degraded turn is history: keyed supersession replaces SLOTS, not
  // the covered past. The default prompt occurrence stays reconstructible in
  // reduced context (it was covered by the request that ran on it), and the
  // wrong-format assistant answer rides every later prompt — the model has
  // "said" it and will see itself having said it. THIS is the pollution a
  // restart/regenesis mechanism (logical vs physical stream paths) would be
  // for; until it exists, the healed agent keeps the scar.
  const contents = h.state().contextItems.map((item) => item.payload.content);
  expect(contents).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
  expect(contents).toContain("plain-prose answer, not in the worker's format");

  await h.play(["append", userMessage("continue")], ["advanceTime", 10_000]);
  const nextPrompt = h.llm.calls
    .at(-1)!
    .messages.map((message) => message.content)
    .join("\n");
  expect(nextPrompt).toContain("plain-prose answer, not in the worker's format");
  expect(nextPrompt).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
});

// -----------------------------------------------------------------------------
// Harness: the generic step harness plus a minimal scripted LLM (mirrors
// agent-processor-no-interpretation.test.ts).
// -----------------------------------------------------------------------------

function userMessage(content: string): ConsumedInput<AgentProcessorContract> {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content,
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

function makeHarness() {
  const calls: {
    model: string;
    messages: WorkersAiMessage[];
    signal: AbortSignal;
    resolve: (result: { text: string }) => void;
  }[] = [];
  const harness = makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: (args) =>
          new Promise((resolve) => {
            calls.push({ ...args, resolve });
          }),
      }),
    path: "/agents/degraded-start-test",
  });
  return {
    ...harness,
    llm: {
      calls,
      respond(text: string) {
        calls.at(-1)!.resolve({ text });
      },
    },
  };
}
