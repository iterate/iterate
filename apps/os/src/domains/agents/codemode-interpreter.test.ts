import { expect, test } from "vitest";
import { makeMemoryProgressStore, makeProcessorHarness } from "iterate/processors/testing";
import {
  CodemodeInterpreterContract,
  CodemodeInterpreterProcessor,
} from "../../../../../configs/codemode-tag/codemode-interpreter.ts";

// The codemode-tag template's derivation processor, driven through the plain
// node harness: assistant output in, consequences out — script runs, chat
// messages, live labels, ephemeral render deltas — every one stamped with
// source.offset provenance to the raw event it derived from.

const CODEMODE_RESPONSE = [
  "Let me compute that.",
  "",
  '<codemode status="factorizing">',
  "return primeFactors(484214)",
  "</codemode>",
].join("\n");

test("a script turn derives its status, script request, and prose — all sourced to the raw event", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append(assistantOutput({ content: CODEMODE_RESPONSE, llmRequestOffset: 7 }));

  const assistantOffset = findEvent(h, "events.iterate.com/agents/context-added").offset;
  const status = findEvent(h, "events.iterate.com/agent/summary-updated");
  const script = findEvent(h, "events.iterate.com/capability-host/script-run-requested");
  const prose = findEvent(h, "events.iterate.com/agents/web-message-sent");

  expect(status).toMatchObject({
    payload: { activity: "factorizing" },
    source: { offset: assistantOffset },
  });
  expect(script).toMatchObject({
    payload: { executionId: `agent-output:${assistantOffset}` },
    source: { offset: assistantOffset },
    idempotencyKey: `agent/script-run-requested@${assistantOffset}`,
  });
  expect(script.payload).toMatchObject({ code: expect.stringContaining("primeFactors(484214)") });
  expect(prose).toMatchObject({
    payload: { message: "Let me compute that.", llmRequestOffset: 7 },
    source: { offset: assistantOffset },
  });
  // Order: status before script before prose — the code step is born with
  // its label, and the prose defers like a mid-script sendMessage.
  expect(status.offset).toBeLessThan(script.offset);
  expect(script.offset).toBeLessThan(prose.offset);
});

test("a prose-only turn derives one message and nothing else", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append(assistantOutput({ content: "hello! all done here.", llmRequestOffset: 7 }));

  const prose = findEvent(h, "events.iterate.com/agents/web-message-sent");
  expect(prose).toMatchObject({ payload: { message: "hello! all done here." } });
  expect(eventTypes(h)).not.toContain("events.iterate.com/capability-host/script-run-requested");
  expect(eventTypes(h)).not.toContain("events.iterate.com/agent/summary-updated");
});

test("a malformed response derives corrective feedback, not a script", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append(
    assistantOutput({ content: "<codemode>\nreturn 1", llmRequestOffset: 7 }), // never closed
  );

  const feedback = h.stream.events.filter(
    (event) =>
      event.type === "events.iterate.com/agents/context-added" &&
      (event.payload as { role?: string }).role === "developer",
  );
  expect(feedback).toHaveLength(1);
  expect(feedback[0].payload).toMatchObject({
    content: expect.stringContaining("did NOT run"),
    llmRequestPolicy: { behaviour: "after-current-request" },
  });
  expect(eventTypes(h)).not.toContain("events.iterate.com/capability-host/script-run-requested");
});

test("while platform parsing is on (the birth default), the interpreter stays idle", async () => {
  const h = makeHarness();
  await h.append(assistantOutput({ content: CODEMODE_RESPONSE, llmRequestOffset: 7 }));
  expect(eventTypes(h)).not.toContain("events.iterate.com/capability-host/script-run-requested");
  expect(eventTypes(h)).not.toContain("events.iterate.com/agents/web-message-sent");
});

test("an unstamped assistant append (no platform processor source) is never interpreted", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append({
    type: "events.iterate.com/agents/context-added",
    payload: { role: "assistant", content: CODEMODE_RESPONSE, llmRequestOffset: 7 },
    // no source.processor stamp — a raw member append
  });
  expect(eventTypes(h)).not.toContain("events.iterate.com/capability-host/script-run-requested");
});

test("a settled script renders its result back as developer context, with duration", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append(assistantOutput({ content: CODEMODE_RESPONSE, llmRequestOffset: 7 }));
  const script = findEvent(h, "events.iterate.com/capability-host/script-run-requested");
  const executionId = (script.payload as { executionId: string }).executionId;

  await h.advanceTime(2500);
  await h.append({
    type: "events.iterate.com/capability-host/script-run-settled",
    payload: {
      executionId,
      settlement: { status: "succeeded", result: { factors: [2, 61, 3967] } },
    },
  });

  const rendered = h.stream.events.findLast(
    (event) =>
      event.type === "events.iterate.com/agents/context-added" &&
      (event.payload as { role?: string }).role === "developer",
  )!;
  expect(rendered.payload).toMatchObject({
    content: expect.stringContaining("Your script returned (in 2.5s):"),
    actor: { type: "script", executionId },
    llmRequestPolicy: { behaviour: "after-current-request" },
  });
  expect(rendered.payload).toMatchObject({
    content: expect.stringContaining("3967"),
  });
});

test("streaming chunks derive ephemeral prose and script deltas, format syntax stripped", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());

  // The response streams in three flushes: prose, tag open + code, close.
  await h.append(chunkFlush(0, "Let me compute that.\n"));
  await h.append(chunkFlush(1, '<codemode status="factorizing">\nreturn primeF'));
  await h.append(chunkFlush(2, "actors(484214)\n</codemode>\n"));

  const messageDeltas = h.stream.events.filter(
    (event) => event.type === "events.iterate.com/render/message-delta",
  );
  const scriptDeltas = h.stream.events.filter(
    (event) => event.type === "events.iterate.com/render/script-delta",
  );
  expect(messageDeltas.length).toBeGreaterThanOrEqual(1);
  expect(messageDeltas[0]).toMatchObject({
    ephemeral: true,
    payload: { llmRequestOffset: 7, text: "Let me compute that." },
  });
  expect(scriptDeltas.length).toBeGreaterThanOrEqual(1);
  expect(scriptDeltas.at(-1)).toMatchObject({
    ephemeral: true,
    payload: {
      llmRequestOffset: 7,
      code: "return primeFactors(484214)",
      status: "factorizing",
    },
  });
});

test("a chunk-sequence gap (eviction mid-stream) silences deltas instead of emitting wrong prose", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  // Sequence 3 arrives first: the earlier flushes died with a previous
  // incarnation and ephemeral events are never redelivered.
  await h.append(chunkFlush(3, "…second half of a sentence"));
  expect(eventTypes(h)).not.toContain("events.iterate.com/render/message-delta");
});

test("replay: a fresh interpreter fed the full stream re-executes nothing", async () => {
  const h = makeHarness();
  await h.append(interpretingEnabled());
  await h.append(assistantOutput({ content: CODEMODE_RESPONSE, llmRequestOffset: 7 }));
  await h.append({
    type: "events.iterate.com/capability-host/script-run-settled",
    payload: {
      executionId: `agent-output:${findEvent(h, "events.iterate.com/agents/context-added").offset}`,
      settlement: { status: "succeeded", result: { ok: true } },
    },
  });
  await h.advanceTime(60_000);
  const committedOffsets = h.events().map((row) => row.offset);
  const headState = h.state();

  // A second harness over the SAME stream and clock with a FRESH progress
  // store: replays every event from offset 0. The raw idempotency keys must
  // collapse every per-event append into a no-op, and the workspace fake
  // throws if a spill re-runs.
  const replay = makeProcessorHarness<CodemodeInterpreterContract, CodemodeInterpreterProcessor>({
    createProcessor: (deps) =>
      new CodemodeInterpreterProcessor(deps, {
        writeWorkspaceFile: async () => {
          throw new Error("replay must not touch the workspace");
        },
      }),
    substrate: {
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(CodemodeInterpreterContract),
    },
  });
  await replay.settle();
  expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
  expect(replay.state()).toEqual(headState);
});

// --- fixtures ---------------------------------------------------------------

function makeHarness() {
  return makeProcessorHarness<CodemodeInterpreterContract, CodemodeInterpreterProcessor>({
    createProcessor: (deps) =>
      new CodemodeInterpreterProcessor(deps, {
        writeWorkspaceFile: async () => {},
      }),
    path: "/agents/web/test",
  });
}

function interpretingEnabled() {
  return {
    type: "events.iterate.com/agent/configured" as const,
    payload: { config: { interpretResponses: false } },
  };
}

function assistantOutput(input: { content: string; llmRequestOffset: number }) {
  return {
    type: "events.iterate.com/agents/context-added" as const,
    payload: { role: "assistant", ...input },
    source: { processor: agentProcessorStamp() },
  };
}

function chunkFlush(sequence: number, text: string) {
  // No explicit ephemeral flag: the contract's catalogue definition forces it.
  return {
    type: "events.iterate.com/agent/llm-response-chunks" as const,
    payload: {
      llmRequestOffset: 7,
      sequence,
      chunks: [{ choices: [{ delta: { content: text } }] }],
    },
  };
}

function agentProcessorStamp() {
  return {
    slug: "agent",
    version: "test",
    stream: {
      path: "/agents/web/test",
      projectId: "proj_harness",
      streamId: "00000000-0000-4000-8000-000000000000",
    },
  };
}

function findEvent(h: { stream: { events: any[] } }, type: string) {
  const event = h.stream.events.find((candidate) => candidate.type === type);
  if (event === undefined) throw new Error(`no ${type} event on the stream`);
  return event;
}

function eventTypes(h: { stream: { events: any[] } }): string[] {
  return h.stream.events.map((event) => event.type);
}
