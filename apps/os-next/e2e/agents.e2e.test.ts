// e2e/agents.e2e.test.ts — AN AGENT IS A DOMAIN OBJECT (src/agent/): a conversation on the context at
// any path, driven by a model that acts by writing scripts against that context's `itx`. `create()`
// births it — the processor row, then `agent/created` on `/` (the catalog `itx.agents.list()` reads) and
// on its path with the system prompt; `message(text)` is a person's words. Everything the loop does is
// an event on the path, so the stories read the log: request → settled + assistant → script requested →
// script settled → developer result → request → settled + assistant prose → idle. The model is `itx.ai`
// under the agent's rules, so a test LENDS a scripted fake there (Misha's shadow, ai-root-shadow); the
// deployed lane runs ONE real turn through Workers AI.
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, sleep, until } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

/** A model that answers from a script of replies, in order, recording what it was asked. */
class ScriptedAi extends RpcTarget {
  readonly calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  constructor(private readonly replies: (string | Error)[]) {
    super();
  }
  run(model: string, inputs: { messages: { role: string; content: string }[] }) {
    this.calls.push({ model, messages: inputs.messages });
    const reply = this.replies[Math.min(this.calls.length, this.replies.length) - 1];
    if (reply instanceof Error) throw reply;
    return { response: reply };
  }
}

const short = (log: { type: string }[]) =>
  log
    .filter((e) => /agent|context-added|script-run/.test(e.type) && !/subscription/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));
const assistantWords = (log: { type: string; payload?: unknown }[]) =>
  log
    .filter((e) => e.type === "events.iterate.com/agents/context-added")
    .map((e) => e.payload as { role: string; content: string })
    .filter((p) => p.role === "assistant")
    .map((p) => p.content);

test("create() births the agent — the processor row, the certificate on / and on its path with the prompt — the catalog lists it, and an agent not created refuses message()", async () => {
  const itx = openItx(freshCtx("agent"));
  expect(await itx.agents.list()).toEqual([]);
  const agent = itx.agents.get("/agents/support");
  await expect(agent.message("hi")).rejects.toThrow(/not created — call create\(\) first/);
  expect(await agent.create({ systemPrompt: "Be terse." })).toEqual({ path: "/agents/support" });
  const own = await readAll(itx.cd("/agents/support"));
  expect(short(own)).toEqual(["agent/created", "agents/context-added"]);
  expect(
    own.filter((e) => e.type === "events.iterate.com/agents/context-added")[0].payload,
  ).toEqual({
    role: "system",
    content: "Be terse.",
  });
  // ONE processor row for the agent (the other row on any context is the project's config funnel).
  expect(
    own
      .filter((e) => e.type === "events.iterate.com/stream/subscription-configured")
      .map((e) => e.payload.name),
  ).toEqual(["config", "agent"]);
  expect(short(await readAll(itx))).toEqual(["agent/created"]); // only the certificate crosses to /
  expect(await itx.agents.list()).toEqual([
    { path: "/agents/support", createdAt: expect.any(String) },
  ]);
  await agent.create(); // created once: answers at once, appends nothing
  expect(await readAll(itx.cd("/agents/support"))).toHaveLength(own.length);
  expect(await itx.repos.list()).toEqual([]);
});

test("the loop: a person's words → the model → a script run against itx → its result → the model → prose, then idle; the script's write is real", async () => {
  const itx = openItx(freshCtx("agent-loop"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi([
    'Let me store that.\n<codemode status="Storing the answer">\nawait itx.kv.put("answer", "42")\nreturn { stored: true }\n</codemode>',
    "Stored 42 under answer.",
  ]);
  await support.provide("itx.ai", ai);
  const agent = itx.agents.get("/agents/support");
  await agent.create({ systemPrompt: "Be terse." });
  const asked = await agent.message("Store 42 under the key answer and tell me when done.");
  expect(asked).toMatchObject({
    type: "events.iterate.com/agents/context-added",
    offset: expect.any(Number),
  });

  const log = await until("the prose that ends the turn", async () => {
    const all = await readAll(support);
    return assistantWords(all).length === 2 ? all : undefined;
  }).catch(async (error: unknown) => {
    const all = await readAll(support);
    console.log(
      "LOOP-LOG",
      JSON.stringify(all.map((e) => [e.type.replace("events.iterate.com/", ""), e.payload])).slice(
        0,
        6000,
      ),
    );
    console.log("LOOP-ROWS", JSON.stringify(await support.subscriptions.list()).slice(0, 2000));
    throw error;
  });
  expect(short(log)).toEqual([
    "agent/created",
    "agents/context-added", // the system prompt
    "agents/context-added", // the person
    "agent/llm-request-requested",
    "agent/llm-request-settled",
    "agents/context-added", // the assistant's raw answer: prose + a tag
    "agent/summary-updated", // the tag's status
    "capability-host/script-run-requested", // the tag's body
    "agents/web-message-sent", // the prose outside the tag
    "capability-host/script-run-settled",
    "agents/context-added", // the developer: the script's result
    "agent/llm-request-requested",
    "agent/llm-request-settled",
    "agents/context-added", // the assistant: prose alone
    "agents/web-message-sent",
  ]);
  const said = (type: string) => log.filter((e) => e.type === type).map((e) => e.payload);
  expect(said("events.iterate.com/agents/web-message-sent")).toEqual([
    { message: "Let me store that.", llmRequestOffset: expect.any(Number) },
    { message: "Stored 42 under answer.", llmRequestOffset: expect.any(Number) },
  ]);
  expect(said("events.iterate.com/agent/summary-updated")).toEqual([
    { activity: "Storing the answer" },
  ]);
  expect(said("events.iterate.com/capability-host/script-run-requested")[0]).toMatchObject({
    code: 'async (itx) => {\nawait itx.kv.put("answer", "42")\nreturn { stored: true }\n}',
  });
  expect(await itx.kv.get("answer")).toBe("42"); // the script ran against the project's itx
  const settledScript = log.find(
    (e) => e.type === "events.iterate.com/capability-host/script-run-settled",
  );
  expect(settledScript.payload.settlement).toEqual({
    status: "succeeded",
    result: { stored: true },
  });
  // The second call saw the whole conversation: prompt, person, its own script, the result.
  expect(ai.calls).toHaveLength(2);
  expect(ai.calls[1]!.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
  expect(ai.calls[1]!.messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "system",
  ]);
  expect(ai.calls[1]!.messages[3]!.content).toContain('"stored": true');
  // Idle: no obligation open, one autonomous turn counted, nothing paused.
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    openRequest: null,
    activeScriptExecutions: {},
    pendingLlmRequestTrigger: null,
    autonomousTurnCount: 1,
    paused: null,
  });
  expect(await itx.agents.list()).toHaveLength(1);
});

test("a script that returns nothing ends the turn: no result item, no further request — over every RPC hop", async () => {
  const itx = openItx(freshCtx("agent-quiet"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi([
    'On it.\n<codemode status="Writing">\nawait itx.kv.put("note", "written")\n</codemode>',
    "SHOULD NEVER BE ASKED",
  ]);
  await support.provide("itx.ai", ai);
  const agent = itx.agents.get("/agents/support");
  await agent.create({ systemPrompt: "Be terse." });
  await agent.message("Write the note.");
  const settled = await until("the script's settlement", async () => {
    const all = await readAll(support);
    return all.find((e) => e.type === "events.iterate.com/capability-host/script-run-settled");
  });
  expect(settled.payload.settlement).toEqual({ status: "succeeded" }); // no result — undefined, not null
  expect(await itx.kv.get("note")).toBe("written");
  await sleep(1_500);
  const log = await readAll(support);
  expect(ai.calls).toHaveLength(1); // the turn ended: the model was never asked again
  expect(short(log).filter((t) => t === "agent/llm-request-requested")).toHaveLength(1);
  expect(
    log
      .filter((e) => e.type === "events.iterate.com/agents/context-added")
      .map((e) => e.payload.role),
  ).toEqual(["system", "user", "assistant"]);
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    pendingLlmRequestTrigger: null,
    openRequest: null,
    activeScriptExecutions: {},
  });
});

test("bounded: a model that never stops scripting trips the autonomous-turn breaker; a person's next words resume it; a model that then keeps failing pauses again", async () => {
  const itx = openItx(freshCtx("agent-breaker"));
  const support = itx.cd("/agents/support");
  // Three scripted answers (the person's turn and two self-triggered ones), then the model is down.
  const script = '<codemode status="Looping">\nreturn { again: true }\n</codemode>';
  await support.provide(
    "itx.ai",
    new ScriptedAi([script, script, script, new Error("model down")]),
  );
  const agent = itx.agents.get("/agents/support");
  await agent.create({ systemPrompt: "Be terse." });
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { maxAutonomousTurns: 2, llmRequestRetryPolicy: { maxAttempts: 2 } } },
  });
  await agent.message("go");
  const paused = await until("the autonomous breaker", async () => {
    const all = await readAll(support);
    return all.find((e) => e.type === "events.iterate.com/agent/paused");
  });
  expect(paused.payload.reason).toMatch(/autonomous turn limit reached \(2/);
  // The person's request ran, then two self-triggered ones; the third self-triggered was refused.
  expect(
    short(await readAll(support)).filter((t) => t === "agent/llm-request-requested"),
  ).toHaveLength(3);
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    paused: { reason: paused.payload.reason },
    openRequest: null,
    autonomousTurnCount: 2,
  });

  // A person's words resume the loop; the model now fails every time, and the retry cap pauses it again.
  await agent.message("try again");
  const pausedAgain = await until("resumed, then the failure breaker", async () => {
    const all = await readAll(support);
    const pauses = all.filter((e) => e.type === "events.iterate.com/agent/paused");
    return all.some((e) => e.type === "events.iterate.com/agent/resumed") && pauses.length === 2
      ? pauses[1]
      : undefined;
  }).catch(async (error: unknown) => {
    // On a timeout, say where the loop stood — the log's shape and the fold — before failing.
    const all = await readAll(support);
    console.log("BREAKER-LOG", JSON.stringify(short(all)));
    console.log("BREAKER-TAIL", JSON.stringify(all.slice(-6).map((e) => [e.type, e.payload])));
    console.log("BREAKER-ROWS", JSON.stringify(await support.subscriptions.list()));
    console.log(
      "BREAKER-SNAP",
      JSON.stringify((await support.facets.get("agent").snapshot()).state),
    );
    throw error;
  });
  expect(pausedAgain.payload.reason).toMatch(/failed 2 times in a row/);
  const settled = (await readAll(support)).filter(
    (e) => e.type === "events.iterate.com/agent/llm-request-settled",
  );
  expect(settled.slice(-2).map((e) => e.payload.result)).toEqual([
    { status: "failed", errorMessage: expect.stringContaining("model down") },
    { status: "failed", errorMessage: expect.stringContaining("model down") },
  ]);
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    consecutiveLlmFailures: 2,
    openRequest: null,
    pendingLlmRequestTrigger: null, // the pause dropped the retry that tripped it
    activeScriptExecutions: {},
  });
  // A PAUSE MAKES NO LOOP: nothing the loop parked can resume it — the log stays as it is.
  const quietFrom = (await readAll(support)).length;
  await sleep(1_500);
  expect(await readAll(support)).toHaveLength(quietFrom);
});

/** A 2×2 solid red PNG — what a vision model is asked about. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";

test("an attached image is stored under the agent's path and SHOWN to the model as an image part; a non-image is named", async () => {
  const itx = openItx(freshCtx("agent-vision"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["A red square and a note."]);
  await support.provide("itx.ai", ai);
  const agent = itx.agents.get("/agents/support");
  await agent.create({ systemPrompt: "Be terse." });
  const asked = await agent.message({
    message: "What do you see?",
    files: [
      { contentType: "image/png", filename: "red dot.png", data: RED_PNG_BASE64 },
      { contentType: "text/plain", filename: "note.txt", data: btoa("a note") },
    ],
  });
  expect(asked.payload.files).toEqual([
    {
      contentType: "image/png",
      filename: "red dot.png",
      path: expect.stringMatching(/^\/agents\/support\/[0-9a-f]{8}-red-dot\.png$/),
      size: 73,
    },
    {
      contentType: "text/plain",
      filename: "note.txt",
      path: expect.stringMatching(/^\/agents\/support\/[0-9a-f]{8}-note\.txt$/),
      size: 6,
    },
  ]);
  // Stored for real, under the agent's path.
  expect(
    (await itx.files.list("/agents/support"))
      .map((f: { size: number }) => f.size)
      .sort((a: number, b: number) => a - b),
  ).toEqual([6, 73]);
  const log = await until("the assistant's prose", async () => {
    const all = await readAll(support);
    return assistantWords(all).length === 1 ? all : undefined;
  });
  expect(assistantWords(log)).toEqual(["A red square and a note."]);
  // The model saw the pixels (a data: URL of the stored bytes) and was told about the note.
  const [call] = ai.calls;
  const message = call!.messages[1] as unknown as {
    role: string;
    content: { type: string; text?: string; image_url?: { url: string } }[];
  };
  expect(message.role).toBe("user");
  expect(message.content[0]).toMatchObject({ type: "text" });
  expect(message.content[0]!.text).toMatch(
    /^What do you see\?\n\[Attached file: note\.txt \(text\/plain, 6 bytes\) — read it with `await itx\.files\.get\("\/agents\/support\/[0-9a-f]{8}-note\.txt"\)\.bytes\(\)`\]$/,
  );
  expect(message.content[1]).toEqual({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${RED_PNG_BASE64}` },
  });
});

deployedOnly(
  "DEPLOYED: the default model SEES an attached image — a red square is called red",
  async () => {
    const itx = openItx(freshCtx("agent-vision-real"));
    const agent = itx.agents.get("/agents/support");
    await agent.create();
    await agent.message({
      message: "What colour is this image? Answer with one word, no code block.",
      files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
    });
    const words = await until(
      "the assistant's answer",
      async () => {
        const said = assistantWords(await readAll(itx.cd("/agents/support")));
        return said.length > 0 ? said : undefined;
      },
      120_000,
    );
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);

deployedOnly(
  "DEPLOYED: one real turn through Workers AI — the default model answers a person in prose",
  async () => {
    const itx = openItx(freshCtx("agent-real"));
    const agent = itx.agents.get("/agents/support");
    await agent.create();
    await agent.message("Reply with the single word: pong. No code block.");
    const words = await until(
      "the assistant's prose",
      async () => {
        const all = await readAll(itx.cd("/agents/support"));
        const said = assistantWords(all);
        return said.length > 0 ? said : undefined;
      },
      120_000,
    );
    expect(words.join("\n")).toMatch(/pong/i);
  },
  150_000,
);
