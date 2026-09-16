import { describe, expect, test, vi } from "vitest";

/* "./processor.js" exists only inside a loaded isolate (the SDK the loader injects). In node the
 * pure half is src/stream/processor.ts; the Durable Object host needs no runtime here. */
vi.mock("./processor.js", async () => {
  const pure = await import("../../src/stream/processor.ts");
  const { z } = await import("zod");
  return { ...pure, z, StreamProcessorDurableObject: class {} };
});

const { scriptOf, VoiceBackendProcessor } = await import("./voice-backend.ts");

describe("scriptOf", () => {
  const rows: { name: string; reply: string; becomes: string | null }[] = [
    {
      name: "a ts fence is the script",
      reply: "```ts\nasync (itx) => 1\n```",
      becomes: "async (itx) => 1",
    },
    {
      name: "an untagged fence counts",
      reply: "sure\n```\nasync (itx) => 2\n```\n",
      becomes: "async (itx) => 2",
    },
    { name: "prose only is the spoken answer", reply: "Two plus two is four.", becomes: null },
    { name: "inline code is not a fence", reply: "use `itx.kv.get`", becomes: null },
  ];
  for (const row of rows) test(row.name, () => expect(scriptOf(row.reply)).toBe(row.becomes));
});

type Appended = { type: string; payload?: Record<string, unknown>; idempotencyKey?: string };

function delegation(delegationId = "d1") {
  return {
    type: "events.iterate.com/voice-agent/delegation-requested" as const,
    offset: 7,
    createdAt: "2026-09-16T00:00:00.000Z",
    path: "/calls/x",
    payload: {
      activation: "act1",
      conversationId: "conv1",
      delegationId,
      transcript: [{ role: "listener" as const, text: "what is two plus two" }],
    },
  };
}

async function run(replies: string[], scriptResults: string[] = []) {
  const completions: { role: string; content: string }[][] = [];
  const scripts: string[] = [];
  const appended: Appended[] = [];
  const processor = new VoiceBackendProcessor({
    complete: async (messages) => {
      completions.push(messages.map((m) => ({ ...m })));
      const reply = replies.shift();
      if (!reply) throw new Error("no more replies");
      return reply;
    },
    runScript: async (script) => {
      scripts.push(script);
      return scriptResults.shift() ?? "null";
    },
    nowMs: () => 1_000,
  });
  const background: Promise<unknown>[] = [];
  const state = processor.contract.initialState();
  processor.processEvent({
    event: delegation() as never,
    state,
    previousState: state,
    append: async (...events) => {
      appended.push(...(events as Appended[]));
      return [];
    },
    blockProcessorWhile: () => undefined,
    runInBackground: (work) => {
      background.push(work());
    },
    delivery: { caughtUp: true },
  });
  await Promise.all(background);
  return { completions, scripts, appended };
}

test("a plain reply becomes one spoken commentary and one settle", async () => {
  const { completions, appended } = await run(["Two plus two is four."]);
  expect(completions).toHaveLength(1);
  expect(completions[0]![0]!.role).toBe("system");
  expect(completions[0]!.at(-1)).toEqual({ role: "user", content: "what is two plus two" });
  expect(appended.map((e) => e.type)).toEqual([
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-backend/turn-settled",
  ]);
  expect(appended[0]!.payload).toEqual({
    activation: "act1",
    delegationId: "d1",
    content: "Two plus two is four.",
  });
  expect(appended[1]!.payload).toMatchObject({ status: "answered", scripts: 0 });
});

test("a fenced script runs, its result is fed back, and the next plain reply is spoken", async () => {
  const { scripts, appended, completions } = await run(
    [
      "```ts\nasync (itx) => (await itx.repos.listFiles('config')).length\n```",
      "There are three files.",
    ],
    ["3"],
  );
  expect(scripts).toEqual(["async (itx) => (await itx.repos.listFiles('config')).length"]);
  expect(completions[1]!.at(-1)).toEqual({ role: "user", content: "Script result:\n3" });
  expect(appended.map((e) => e.type)).toEqual([
    "events.iterate.com/voice-agent/thinking",
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-backend/turn-settled",
  ]);
  expect(appended[1]!.payload?.content).toBe("There are three files.");
  expect(appended[2]!.payload).toMatchObject({ scripts: 1 });
});

test("a goodbye with the hang-up token hangs up without saying the token", async () => {
  const { appended } = await run(["Bye for now. HANG_UP"]);
  expect(appended[0]!.payload).toEqual({
    activation: "act1",
    delegationId: "d1",
    content: "Bye for now.",
    hangUp: true,
  });
});

test("a model failure is spoken as a failure and settled as failed", async () => {
  const { appended } = await run([]);
  expect(appended[0]!.payload?.content).toMatch(/^Sorry, that did not work: no more replies/);
  expect(appended[1]!.payload).toMatchObject({ status: "failed" });
});

test("a settled delegation is not answered twice", async () => {
  const processor = new VoiceBackendProcessor({
    complete: async () => {
      throw new Error("must not be called");
    },
    runScript: async () => "null",
    nowMs: () => 0,
  });
  const state = processor.reduce({
    state: processor.contract.initialState(),
    event: {
      type: "events.iterate.com/voice-backend/turn-settled",
      offset: 9,
      createdAt: "2026-09-16T00:00:00.000Z",
      path: "/calls/x",
      payload: {
        activation: "act1",
        delegationId: "d1",
        status: "answered",
        answer: "four",
        scripts: 0,
        elapsedMs: 1,
      },
    } as never,
  })!;
  expect(state.settled).toEqual(["d1"]);
  const calls: Promise<unknown>[] = [];
  processor.processEvent({
    event: delegation("d1") as never,
    state,
    previousState: state,
    append: async () => [],
    blockProcessorWhile: () => undefined,
    runInBackground: (work) => {
      calls.push(work());
    },
    delivery: { caughtUp: true },
  });
  expect(calls).toHaveLength(0);
});
