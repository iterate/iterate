// e2e/agents.e2e.test.ts — AN AGENT IS A DOMAIN OBJECT (src/agent/): a conversation on the context at
// any path, driven by a model that acts by writing scripts against that context's `itx`.
// `itx.agents.create(path)` births it — the processor row, `agent/create-requested`, then the saga
// lands `agent/created` on `/` (the catalog `itx.agents.list()` reads) and on its path with the
// default system prompt; an operator's instructions are their own `agent/context-added` through the
// handle's typed `append`; `message(text)` is a person's words. Everything the loop does is an event
// on the path, so the stories read the log: request → settled + assistant → script requested →
// script settled → developer result → request → settled + assistant prose → idle. The model is `itx.ai`
// under the agent's rules, so a test LENDS a scripted fake there (Misha's shadow, ai-root-shadow); the
// deployed lane runs ONE real turn through Workers AI.
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { collector, freshCtx, openItx, readAll, sleep, until } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

/** A model that answers from a script of replies, in order, recording what it was asked. A reply
 *  may take its time (`{ text, afterMs }`): the request stays in flight that long — what an
 *  interruption needs to have something to cut short. The fake answers WHOLE (a lent stub carries
 *  no stream), so the loop journals its one chunk window; streaming proper is the deployed story. */
class ScriptedAi extends RpcTarget {
  readonly calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  constructor(private readonly replies: (string | Error | { text: string; afterMs: number })[]) {
    super();
  }
  async run(model: string, inputs: { messages: { role: string; content: string }[] }) {
    this.calls.push({ model, messages: inputs.messages });
    const reply = this.replies[Math.min(this.calls.length, this.replies.length) - 1];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string") return { response: reply };
    await sleep(reply.afterMs);
    return { response: reply.text };
  }
}

const short = (log: { type: string }[]) =>
  log
    .filter((e) => /^events\.iterate\.com\/(agent\/|context\/run-)/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));
/** The default model is OpenAI's astra; a local story pins Workers AI so the fake `itx.ai` answers. */
const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const onWorkersAi = (
  support: { append: (event: unknown) => Promise<unknown> },
  model = WORKERS_AI_MODEL,
) =>
  support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model } } },
  });

const assistantWords = (log: { type: string; payload?: unknown }[]) =>
  log
    .filter((e) => e.type === "events.iterate.com/agent/context-added")
    .map((e) => e.payload as { role: string; content: string })
    .filter((p) => p.role === "assistant")
    .map((p) => p.content);

test("itx.agents.create(path) births the agent — the processor row, the request, the certificate on / and on its path with the default prompt; an operator's prompt is its own append; the catalog lists it; an agent not created refuses message()", async () => {
  const itx = openItx(freshCtx("agent"));
  expect(await itx.agents.list()).toEqual([]);
  const agent = itx.agents.get("/agents/support");
  await expect(agent.message("hi")).rejects.toThrow(
    /not created — itx\.agents\.create\("\/agents\/support"\) first/,
  );
  expect(await itx.agents.create("/agents/support")).toEqual({ path: "/agents/support" });
  // The operator's instructions ADD to the platform's rules — their own keyed item after the
  // birth, through the handle's typed append; a system item raises no turn.
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  const own = await readAll(itx.cd("/agents/support"));
  expect(short(own)).toEqual([
    "agent/create-requested",
    "agent/created",
    "agent/context-added", // the default prompt, beside the certificate
    "agent/context-added", // the operator's
  ]);
  const [defaultPrompt, operatorPrompt] = own
    .filter((e) => e.type === "events.iterate.com/agent/context-added")
    .map((e) => e.payload as { role: string; content: string });
  // The default prompt: the codemode format, the itx surface, and which project this is.
  expect(defaultPrompt!.role).toBe("system");
  expect(defaultPrompt!.content).toMatch(/^You are an agent on the iterate platform/);
  expect(defaultPrompt!.content).toMatch(/<codemode/);
  expect(defaultPrompt!.content).toContain(
    `\nCURRENT PROJECT: ${JSON.stringify(await itx.cd("/agents/support").whoami())}`,
  );
  expect(operatorPrompt).toEqual({ role: "system", content: "Be terse." });
  // One explicit processor row for the agent; no automatic config subscription.
  expect(
    own
      .filter((e) => e.type === "events.iterate.com/stream/subscription-configured")
      .map((e) => e.payload.name),
  ).toEqual(["agent"]);
  expect(short(await readAll(itx))).toEqual(["agent/created"]); // only the certificate crosses to /
  expect(await itx.agents.list()).toEqual([
    { path: "/agents/support", createdAt: expect.any(String) },
  ]);
  await itx.agents.create("/agents/support"); // created once: answers at once, appends nothing
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
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await onWorkersAi(support);
  const asked = await agent.message("Store 42 under the key answer and tell me when done.");
  expect(asked).toMatchObject({
    type: "events.iterate.com/agent/context-added",
    offset: expect.any(Number),
  });

  // Wait for the LAST derived fact: the plain-response handler's run-settled, appended a
  // beat after the prose's web-message-sent it follows — reading at the prose raced it on the
  // deployed worker (17 of the 18 events, twice on main).
  const log = await until("the settle that ends the turn", async () => {
    const all = await readAll(support);
    const count = (type: string) =>
      all.filter((e) => e.type === `events.iterate.com/${type}`).length;
    return count("agent/web-message-sent") === 2 && count("context/run-settled") === 2
      ? all
      : undefined;
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
    "agent/create-requested",
    "agent/created",
    "agent/context-added", // the default system prompt
    "agent/context-added", // the operator's
    "agent/configured", // the story pins Workers AI
    "agent/context-added", // the person
    "agent/llm-request-requested",
    "agent/llm-request-settled",
    "agent/context-added", // the assistant's raw answer: prose + a tag
    "agent/summary-updated", // the tag's status
    "context/run-requested", // the tag's body
    "agent/web-message-sent", // the prose outside the tag
    "context/run-settled",
    "agent/context-added", // the developer: the script's result
    "agent/llm-request-requested",
    "agent/llm-request-settled",
    "agent/context-added", // the assistant: a bare reply (no tag)
    "context/run-requested", // the plain-response handler (itx.chat.sendMessage)
    "agent/web-message-sent", // its sendMessage
    "context/run-settled",
  ]);
  const said = (type: string) => log.filter((e) => e.type === type).map((e) => e.payload);
  expect(said("events.iterate.com/agent/web-message-sent")).toEqual([
    // The tag's prose is sent directly (with the request it came from); the bare reply is sent by
    // the plain-response handler's sendMessage — a plain message, no request offset.
    { message: "Let me store that.", llmRequestOffset: expect.any(Number) },
    { message: "Stored 42 under answer." },
  ]);
  expect(said("events.iterate.com/agent/summary-updated")).toEqual([
    { activity: "Storing the answer" },
  ]);
  expect(said("events.iterate.com/context/run-requested")[0]).toMatchObject({
    code: 'async (itx) => {\nawait itx.kv.put("answer", "42")\nreturn { stored: true }\n}',
  });
  expect(await itx.kv.get("answer")).toBe("42"); // the script ran against the project's itx
  const settledScript = log.find((e) => e.type === "events.iterate.com/context/run-settled");
  expect(settledScript.payload.settlement).toEqual({
    status: "succeeded",
    result: { stored: true },
  });
  // The second call saw the whole conversation: both prompts, person, its own script, the result.
  expect(ai.calls).toHaveLength(2);
  expect(ai.calls[1]!.model).toBe(WORKERS_AI_MODEL);
  expect(ai.calls[1]!.messages.map((m) => m.role)).toEqual([
    "system",
    "system",
    "user",
    "assistant",
    "system",
  ]);
  expect(ai.calls[1]!.messages[4]!.content).toContain('"stored": true');
  // Idle: no obligation open, one autonomous turn counted, nothing paused.
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    openRequest: null,
    pendingLlmRequestTrigger: null,
    autonomousTurnCount: 1,
    paused: null,
  });
  expect(await itx.agents.list()).toHaveLength(1);
});

test("debounced: two messages inside the window are answered by ONE request that saw both; a message after the answer is another turn", async () => {
  const itx = openItx(freshCtx("agent-debounce"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["Both noted.", "Third noted."]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: WORKERS_AI_MODEL }, llmRequestDebounceMs: 1_500 } },
  });
  await agent.message("First.");
  await agent.message("Second, right after.");
  const first = await until("the one answer", async () => {
    const all = await readAll(support);
    return assistantWords(all).length === 1 ? all : undefined;
  });
  expect(assistantWords(first)).toEqual(["Both noted."]);
  // ONE request opened and ran (the second message's late intent is a harmless fact the reduce
  // ignores — apps/os's rule — so the intents may number two; the settlements never do).
  expect(short(first).filter((t) => t === "agent/llm-request-settled")).toHaveLength(1);
  expect(ai.calls).toHaveLength(1);
  // The one call saw both messages — the prompt is built from the log at run time.
  expect(ai.calls[0]!.messages.map((m) => m.role)).toEqual(["system", "system", "user", "user"]);
  // The window, not a coincidence: the request landed at least the window after the FIRST words
  // (said[0] and said[1] are the two system prompts).
  const said = first.filter((e) => e.type === "events.iterate.com/agent/context-added");
  const requested = first.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  expect(Date.parse(requested.createdAt) - Date.parse(said[2].createdAt)).toBeGreaterThanOrEqual(
    1_400,
  );
  // Words after the answer are a new trigger: a second window, a second request.
  await agent.message("Third.");
  const second = await until("the second answer", async () => {
    const all = await readAll(support);
    return assistantWords(all).length === 2 ? all : undefined;
  });
  expect(assistantWords(second)).toEqual(["Both noted.", "Third noted."]);
  expect(ai.calls).toHaveLength(2);
});

test("a script that returns nothing ends the turn: no result item, no further request — over every RPC hop", async () => {
  const itx = openItx(freshCtx("agent-quiet"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi([
    'On it.\n<codemode status="Writing">\nawait itx.kv.put("note", "written")\n</codemode>',
    "SHOULD NEVER BE ASKED",
  ]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await onWorkersAi(support);
  await agent.message("Write the note.");
  const settled = await until("the script's settlement", async () => {
    const all = await readAll(support);
    return all.find((e) => e.type === "events.iterate.com/context/run-settled");
  });
  expect(settled.payload.settlement).toEqual({ status: "succeeded" }); // no result — undefined, not null
  expect(await itx.kv.get("note")).toBe("written");
  await sleep(1_500);
  const log = await readAll(support);
  expect(ai.calls).toHaveLength(1); // the turn ended: the model was never asked again
  expect(short(log).filter((t) => t === "agent/llm-request-requested")).toHaveLength(1);
  expect(
    log
      .filter((e) => e.type === "events.iterate.com/agent/context-added")
      .map((e) => e.payload.role),
  ).toEqual(["system", "system", "user", "assistant"]);
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    pendingLlmRequestTrigger: null,
    openRequest: null,
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
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: {
      config: {
        llm: { model: WORKERS_AI_MODEL },
        maxAutonomousTurns: 2,
        // A short backoff so the retry (and the pause after it) lands within the story's patience.
        llmRequestRetryPolicy: { maxAttempts: 2, backoffBaseMs: 50, backoffMaxMs: 100 },
      },
    },
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
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await onWorkersAi(support);
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
  // the default prompt, the operator's, then the person's words with their attachments
  const message = call!.messages[2] as unknown as {
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

test("streamed: the answer reaches a live subscriber as ephemeral chunk windows before it settles — never a stored row", async () => {
  const itx = openItx(freshCtx("agent-chunks"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["Four words, no code."]);
  await support.provide("itx.ai", ai);
  const windows = collector();
  await support.subscribe({
    name: "chunks",
    consumes: ["events.iterate.com/agent/llm-response-chunks"],
    target: windows.fn,
  });
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await onWorkersAi(support);
  await agent.message("Say four words.");
  const log = await until("the settled request", async () => {
    const all = await readAll(support);
    return all.some((e) => e.type === "events.iterate.com/agent/llm-request-settled")
      ? all
      : undefined;
  });
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  await until("the chunk window", () => windows.invocations.length >= 1);
  // The fake answers whole, so its answer is ONE window: the request it belongs to, the provider's
  // chunk verbatim (Workers AI's `{ response }`), the first sequence number.
  expect(windows.types()).toEqual(["events.iterate.com/agent/llm-response-chunks"]);
  expect(windows.invocations[0]!.events[0]!.payload).toEqual({
    llmRequestOffset: requested.offset,
    chunks: [{ response: "Four words, no code." }],
    sequence: 0,
  });
  // Ephemeral: the durable log holds no chunk row, and the settlement carries the text.
  expect(log.filter((e) => e.type === "events.iterate.com/agent/llm-response-chunks")).toEqual([]);
  expect(
    log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled")!.payload.result,
  ).toEqual({ status: "succeeded", text: "Four words, no code." });
});

test("interrupted: the person's next words cut the running answer short — settled cancelled, and those words start the next turn", async () => {
  const itx = openItx(freshCtx("agent-interrupt"));
  const support = itx.cd("/agents/support");
  // The first answer takes long enough to be cut short; the second is what the person gets.
  const ai = new ScriptedAi([{ text: "A long answer that never lands.", afterMs: 8_000 }, "Sure."]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });
  await onWorkersAi(support);
  await agent.message("Tell me everything.");
  await until("the request is in flight", async () =>
    (await readAll(support)).some(
      (e) => e.type === "events.iterate.com/agent/llm-request-requested",
    ),
  );
  await sleep(500); // the runner has dialed the model
  // apps/os's interrupt: a developer item from the person, its policy the cancellation.
  await support.append({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content: "The user interrupted the in-progress response from the web chat.",
      actor: { type: "user" },
      llmRequestPolicy: { behaviour: "interrupt-current-request" },
    },
  });
  const log = await until(
    "the interruption's settlement, then the next turn's answer",
    async () => {
      const all = await readAll(support);
      return all.filter((e) => e.type === "events.iterate.com/agent/llm-request-settled").length ===
        2
        ? all
        : undefined;
    },
    30_000,
  );
  const settled = log
    .filter((e) => e.type === "events.iterate.com/agent/llm-request-settled")
    .map((e) => e.payload.result);
  // The fake streams nothing, so no partial text rides the cancellation.
  expect(settled).toEqual([
    { status: "cancelled", reason: "interrupted-by-user-input" },
    { status: "succeeded", text: "Sure." },
  ]);
  // The cut-short answer never became the assistant's words; the second request saw the
  // interruption as the newest words.
  expect(assistantWords(log)).toEqual(["Sure."]);
  expect(ai.calls).toHaveLength(2);
  expect(ai.calls[1]!.messages.at(-1)!.content).toContain("interrupted the in-progress response");
  expect((await support.facets.get("agent").snapshot()).state).toMatchObject({
    openRequest: null,
    pendingLlmRequestTrigger: null,
    paused: null,
  });
});

deployedOnly(
  "DEPLOYED: one real turn through the default model, OpenAI's astra streamed from the Responses API on Cloudflare's billing — chunk windows fly, the settlement carries the usage",
  async () => {
    const itx = openItx(freshCtx("agent-real"));
    const support = itx.cd("/agents/support");
    const windows = collector();
    await support.subscribe({
      name: "chunks",
      consumes: ["events.iterate.com/agent/llm-response-chunks"],
      target: windows.fn,
    });
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await agent.message(
      "Reply with the single word: pong, then one sentence about what a pong is. No code block.",
    );
    const log = await until(
      "the assistant's prose",
      async () => {
        const all = await readAll(support);
        return assistantWords(all).length > 0 ? all : undefined;
      },
      120_000,
    );
    expect(assistantWords(log).join("\n")).toMatch(/pong/i);
    // The stream: at least one window of Responses API events, in order, for this request.
    const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
    await until("the chunk windows", () => windows.invocations.length >= 1);
    const chunkEvents = windows.invocations.flatMap((i) => i.events);
    expect(chunkEvents.every((e) => e.payload.llmRequestOffset === requested.offset)).toBe(true);
    expect(chunkEvents.map((e) => e.payload.sequence)).toEqual(
      chunkEvents.map((_, index) => index),
    );
    const deltas = chunkEvents.flatMap((e) =>
      e.payload.chunks.filter((c: { type?: string }) => c.type === "response.output_text.delta"),
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((c: { delta: string }) => c.delta).join("")).toMatch(/pong/i);
    // The cost, twice: on the settlement and as the report a feed shows the context's fullness by.
    const settled = log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled");
    expect(settled.payload.result).toMatchObject({
      status: "succeeded",
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    });
    expect(
      log.find((e) => e.type === "events.iterate.com/agent/token-usage-reported")?.payload,
    ).toMatchObject({ model: "gpt-6-astra", maxContextTokens: 272_000 });
  },
  150_000,
);

deployedOnly(
  "DEPLOYED: the default model SEES an attached image — a red square is called red",
  async () => {
    const itx = openItx(freshCtx("agent-vision-real"));
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
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
  "DEPLOYED: a Workers AI model, pinned by agent/configured, sees the image too — no OpenAI key needed",
  async () => {
    const itx = openItx(freshCtx("agent-vision-cf"));
    const support = itx.cd("/agents/support");
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await onWorkersAi(support);
    await agent.message({
      message: "What colour is this image? Answer with one word, no code block.",
      files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
    });
    const words = await until(
      "the assistant's answer",
      async () => {
        const said = assistantWords(await readAll(support));
        return said.length > 0 ? said : undefined;
      },
      120_000,
    );
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);
