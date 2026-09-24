// e2e/agents.e2e.test.ts — AN AGENT IS A DOMAIN OBJECT (runtime/): a conversation on the context at
// any path, driven by a model that acts by writing scripts against that context's `itx`.
// `itx.agents.create(path)` births it — the processor row, `agent/create-requested`, then the saga
// lands `agent/created` on `/` (the catalog `itx.agents.list()` reads) and on its path with the
// default system prompt; an operator's instructions are their own `agent/context-added` through the
// handle's typed `append`; `message(text)` is a person's words. Everything the loop does is an event
// on the path, so the stories read the log: request → settled + assistant → script requested →
// script settled → developer result → request → settled + assistant prose → idle. The model is `itx.ai`
// under the agent's rules, so a test LENDS a scripted fake there (Misha's shadow, ai-root-shadow); the
// deployed suite runs ONE real turn through Workers AI.
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { createFlake } from "@iterate-com/shared/test-support/flake-test";
import { errorCode } from "iterate/lib";
import {
  disposeSessions,
  freshCtx,
  openItx,
  processorNames,
  readAll,
  rejection,
  sleep,
  until,
  untilValue,
} from "../../os/e2e/support/client.ts";
import { openAgentItx } from "./support.ts";
import {
  RED_PNG_BASE64,
  ScriptedAi,
  WORKERS_AI_MODEL,
  assistantWords,
  configureModel,
  operatorPrompt,
  short,
} from "./fixtures.ts";

test("a fully masked visitor sandbox can receive a prose reply without gaining tools", async () => {
  const itx = await openAgentItx(freshCtx("agent-no-tools"));
  const path = "/agents/visitor";
  const support = itx.cd(path);
  await support.provide("itx.ai", new ScriptedAi(["Here is a domain from the catalogue."]));
  await itx.agents.create(path);
  await itx.cd(`${path}/sandbox`).append(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx", target: null },
    },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.agents", target: null },
    },
  );
  await configureModel(support);
  await itx.agents.get(path).message("Suggest a name in prose.");
  const log = await until("prose reply with no sandbox capabilities", async () => {
    const events = await readAll(support);
    return events.some((event) => event.type === "events.iterate.com/agent/web-message-sent")
      ? events
      : undefined;
  });
  expect(assistantWords(log)).toContain("Here is a domain from the catalogue.");
  expect(log.some((event) => event.type === "events.iterate.com/context/run-requested")).toBe(
    false,
  );
  await expect(itx.cd(`${path}/sandbox`).kv.get("anything")).rejects.toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
  await expect(itx.cd(`${path}/sandbox`).agents.list()).rejects.toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
});

test("itx.agents.create(path) births the agent — the processor row, the request, the certificate on / and on its path with the default prompt; an operator's prompt is its own append; the catalog lists it; an agent not created refuses message()", async () => {
  const itx = await openAgentItx(freshCtx("agent"));
  expect(await itx.agents.list()).toEqual([]);
  const agent = itx.agents.get("/agents/support");
  await expect(agent.message("hi")).rejects.toThrow(
    /not created — itx\.agents\.create\("\/agents\/support"\) first/,
  );
  expect(await itx.agents.create("/agents/support")).toEqual({ path: "/agents/support" });
  // The operator's instructions ADD to the default prompt — their own keyed item after the
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
  expect(defaultPrompt).toMatchObject({ role: "system" });
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
  const itx = await openAgentItx(freshCtx("agent-loop"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi([
    'Let me store that.\n<codemode status="Storing the answer">\nawait itx.kv.put("answer", "42")\nreturn { stored: true }\n</codemode>',
    "Stored 42 under answer.",
  ]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
  await configureModel(support);
  const asked = await agent.message("Store 42 under the key answer and tell me when done.");
  expect(asked).toMatchObject({
    type: "events.iterate.com/agent/context-added",
    offset: expect.any(Number),
  });

  // Wait for the LAST derived fact: the bare reply's web-message-sent (appended directly, no script),
  // a beat after the script's run-settled — reading at the prose raced it on the deployed worker
  // (17 of the 18 events, twice on main).
  const log = await until("the settle that ends the turn", async () => {
    const all = await readAll(support);
    const count = (type: string) =>
      all.filter((e) => e.type === `events.iterate.com/${type}`).length;
    return count("agent/web-message-sent") === 2 && count("context/run-settled") === 1
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
    "agent/web-message-sent", // appended directly — the reply is an event, not a script
  ]);
  const said = (type: string) => log.filter((e) => e.type === type).map((e) => e.payload);
  expect(said("events.iterate.com/agent/web-message-sent")).toEqual([
    // The tag's prose and the bare reply alike are appended directly, each with the request it came from.
    { message: "Let me store that.", llmRequestOffset: expect.any(Number) },
    { message: "Stored 42 under answer.", llmRequestOffset: expect.any(Number) },
  ]);
  expect(said("events.iterate.com/agent/summary-updated")).toEqual([
    { activity: "Storing the answer" },
  ]);
  expect(said("events.iterate.com/context/run-requested")[0]).toMatchObject({
    code: 'async (itx) => {\nawait itx.kv.put("answer", "42")\nreturn { stored: true }\n}',
  });
  expect(await itx.kv.get("answer")).toBe("42"); // the script ran against the project's itx
  const settledScript = log.find((e) => e.type === "events.iterate.com/context/run-settled");
  expect(settledScript.payload).toMatchObject({
    settlement: {
      status: "succeeded",
      result: { stored: true },
    },
  });
  // The second call saw the whole conversation: both prompts, person, its own script, the result.
  expect(ai.calls).toHaveLength(2);
  expect(ai.calls[1]).toMatchObject({ model: WORKERS_AI_MODEL });
  expect(ai.calls[1]!.messages.map((m) => m.role)).toEqual([
    "system", // the journaled default prompt
    "system", // the operator's
    "system", // the capability tree, rendered this turn
    "user",
    "assistant",
    "system",
  ]);
  expect(ai.calls[1]!.messages[5]!.content).toContain('"stored": true');
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
  const itx = await openAgentItx(freshCtx("agent-debounce"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["Both noted.", "Third noted."]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
  // The window is the story's premise — the second words must land inside it, a full round trip
  // after the first — so it is generous: at 1.5 s a loaded run's second message landed after it
  // closed, and the one request saw the first words alone (soak 2026-09-24, agents.e2e).
  const windowMs = 5_000;
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: WORKERS_AI_MODEL }, llmRequestDebounceMs: windowMs } },
  });
  await agent.message("First.");
  await agent.message("Second, right after.");
  const first = await until("the one answer", async () => {
    const all = await readAll(support);
    return assistantWords(all).length === 1 ? all : undefined;
  });
  // THE PREMISE, said as itself when it fails: both words landed inside the window.
  const words = first.filter(
    (e) => e.type === "events.iterate.com/agent/context-added" && e.payload.role === "user",
  );
  expect(
    Date.parse(words[1]?.createdAt) - Date.parse(words[0]?.createdAt),
    `the second words landed inside the ${windowMs} ms window: ${JSON.stringify(words.map((e) => e.createdAt))}`,
  ).toBeLessThan(windowMs);
  expect(assistantWords(first)).toEqual(["Both noted."]);
  // ONE request opened and ran (the second message's late intent is a harmless fact the reduce
  // ignores, so the intents may number two; the settlements never do).
  expect(short(first).filter((t) => t === "agent/llm-request-settled")).toHaveLength(1);
  expect(ai.calls).toHaveLength(1);
  // The one call saw both messages — the prompt is built from the log at run time.
  expect(ai.calls[0]!.messages.map((m) => m.role)).toEqual([
    "system", // the default prompt
    "system", // the operator's
    "system", // the capability tree
    "user",
    "user",
  ]);
  // The window, not a coincidence: the request landed at least the window after the FIRST words
  // (said[0] and said[1] are the two system prompts).
  const said = first.filter((e) => e.type === "events.iterate.com/agent/context-added");
  const requested = first.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  expect(Date.parse(requested.createdAt) - Date.parse(said[2].createdAt)).toBeGreaterThanOrEqual(
    windowMs - 100,
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
  const itx = await openAgentItx(freshCtx("agent-quiet"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi([
    'On it.\n<codemode status="Writing">\nawait itx.kv.put("note", "written")\n</codemode>',
    "SHOULD NEVER BE ASKED",
  ]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
  await configureModel(support);
  await agent.message("Write the note.");
  // a wait that runs out names the turn's log so far (which hop it stopped at)
  const isSettlement = (e: { type: string }) => e.type === "events.iterate.com/context/run-settled";
  const settled = (
    await untilValue(
      "the script's settlement",
      () => readAll(support),
      (all) => all.some(isSettlement),
      {
        describe: short,
      },
    )
  ).find(isSettlement);
  expect(settled.payload).toMatchObject({ settlement: { status: "succeeded" } });
  expect(settled.payload.settlement.result).toBeUndefined(); // no result — undefined, not null
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
  const itx = await openAgentItx(freshCtx("agent-breaker"));
  const support = itx.cd("/agents/support");
  // Three scripted answers (the person's turn and two self-triggered ones), then the model is down.
  const script = '<codemode status="Looping">\nreturn { again: true }\n</codemode>';
  await support.provide(
    "itx.ai",
    new ScriptedAi([script, script, script, new Error("model down")]),
  );
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
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

test("an attached image is stored under the agent's path and SHOWN to the model as an image part; a non-image is named", async () => {
  const itx = await openAgentItx(freshCtx("agent-vision"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["A red square and a note."]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
  await configureModel(support);
  const asked = await agent.message({
    message: "What do you see?",
    files: [
      { contentType: "image/png", filename: "red dot.png", data: RED_PNG_BASE64 },
      { contentType: "text/plain", filename: "note.txt", data: btoa("a note") },
    ],
  });
  expect(asked.payload).toMatchObject({
    files: [
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
    ],
  });
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
  // the default prompt, the operator's, the capability tree, then the person's words with their attachments
  const message = call!.messages[3] as unknown as {
    role: string;
    content: { type: string; text?: string; image_url?: { url: string } }[];
  };
  expect(message).toMatchObject({ role: "user" });
  expect(message.content[0]).toMatchObject({ type: "text" });
  expect(message.content[0]!.text).toMatch(
    /^What do you see\?\n\[Attached file: note\.txt \(text\/plain, 6 bytes\) — read it with `await itx\.files\.get\("\/agents\/support\/[0-9a-f]{8}-note\.txt"\)\.bytes\(\)`\]$/,
  );
  expect(message.content[1]).toEqual({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${RED_PNG_BASE64}` },
  });
});

test("interrupted: the person's next words cut the running answer short — settled cancelled, and those words start the next turn", async () => {
  const itx = await openAgentItx(freshCtx("agent-interrupt"));
  const support = itx.cd("/agents/support");
  // The first answer takes long enough to be cut short; the second is what the person gets.
  const ai = new ScriptedAi([{ text: "A long answer that never lands.", afterMs: 8_000 }, "Sure."]);
  await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await operatorPrompt(agent);
  await configureModel(support);
  await agent.message("Tell me everything.");
  await until("the request is in flight", async () =>
    (await readAll(support)).some(
      (e) => e.type === "events.iterate.com/agent/llm-request-requested",
    ),
  );
  await sleep(500); // the runner has dialed the model
  // The interrupt: a developer item from the person, its policy the cancellation.
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

// ── the tree the model reads, and the sandbox the scripts run in ──

test("the model is shown the SANDBOX's rewriteRules.list() every turn: a capability provided at the root with a description reaches the prompt, tagged with the context it came from", async () => {
  const itx = await openAgentItx(freshCtx("agent-tree"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["Nothing to do."]);
  await support.provide("itx.ai", ai);
  await itx.provide("itx.tool", "itx.whoami", {
    description: "who this project is, really: itx.tool()",
  });
  const agent = itx.agents.get("/agents/support");
  await itx.agents.create("/agents/support");
  await operatorPrompt(agent);
  await configureModel(support);
  await agent.message("hello");
  await until("the model was asked", () => (ai.calls.length > 0 ? true : undefined));
  const system = ai.calls[0]!.messages.filter((m) => m.role === "system").map((m) => m.content);
  const tree = system.find((content) =>
    content.includes("CAPABILITY TREE (`await itx.rewriteRules.list()`)"),
  );
  expect(tree).toBeDefined();
  expect(tree).toContain("itx.tool — who this project is, really: itx.tool()");
  expect(tree).toContain("from /:"); // rows are grouped by the context they came from
  expect(tree).toContain("itx.kv — "); // the root's implicit rows, described
});

/** THE PLATFORM'S SUBREQUEST DEPTH, THE JAIL's one known flake. An agent's turns can nest in
 *  Cloudflare's call chain: a Durable Object's outgoing calls count from the depth of its NEWEST
 *  in-flight incoming call (workerd `IoContext::getCurrentIncomingRequest`), and each turn's
 *  run-requested arrives at the agent's context from its facet (facet → env.ITX → context), a hop
 *  or three deeper than the delivery that started the turn. When no shallower call reaches the
 *  context in between, the next turn starts from there, and a script's platform hops (here the
 *  physical `itx.repos` grant: sandbox → loaded isolate → env.ITX → sandbox → `/` → the `project`
 *  facet) eventually pass the limit: "Subrequest depth limit exceeded". Measured on a preview
 *  (2026-09-24): from a session a sandbox script has 9 levels of nested `itx.run` left; turn by
 *  turn in the agent loop it had 9,9,9,9,9,8,8,8,8,7,7,7 or 9,8,7,7,9,… — the chain grows until a
 *  shallower call resets it. Soaked alone THE JAIL failed 1 of 40 runs this way, beside the rest of
 *  this file 3 of 46, and 5 of 15 in the full suite (never a different error). The agent loop's
 *  depth is the product's to fix (the turn must start from a fresh invocation); until then the
 *  row is green on exactly this failure and recorded, and any other failure is red. */
const jailFlake = createFlake(test, /Subrequest depth limit exceeded/, { timeoutMs: 60_000 });

jailFlake(
  "THE JAIL: a bare null on the agent's sandbox plus one grant — an injected script reaches nothing but the grant, and the tables are untouched afterwards",
  async () => {
    const ctx = freshCtx("agent-jail");
    const itx = await openAgentItx(ctx);
    const agentPath = "/agents/web/v1";
    const support = itx.cd(agentPath);
    const catalogue = new (class extends RpcTarget {
      search(input: { q: string }) {
        return [{ name: `${input.q}.com`, price: 42 }];
      }
    })();
    await itx.provide("itx.catalogue", catalogue, { description: "search the catalogue" });
    const scripts = [
      "return await itx.kv.list()",
      "return await itx.cd('/').whoami()",
      "return await itx.builtins.whoami()",
      "const r = await fetch('https://example.com/'); return r.status",
      "await itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match: 'itx', target: \"itx.builtins.cd('/')\" } }); return 'granted myself'",
      "await itx.schedules.set({ key: 'later', when: { afterMs: 10 }, events: [{ type: 't' }] }); return 'scheduled'",
      "await itx.provide('itx.catalogue', () => 'mine now'); return 'lent over the grant'",
      "await itx.subscribe({ target: () => {} }); return 'subscribed'",
      "return await itx.catalogue.search({ q: 'ship' })",
      "return await itx.repos.list()",
    ];
    const ai = new ScriptedAi([
      ...scripts.map((code) => `<codemode status="probing">\n${code}\n</codemode>`),
      "Done probing.",
    ]);
    await support.provide("itx.ai", ai);
    const agent = itx.agents.get(agentPath);
    await itx.agents.create(agentPath);
    await configureModel(support);
    // THE OWNER's jail, in ONE batch: the mask replaces the sandbox's link, the grant sits beside it
    // (the append itself resolves before the mask lands; afterwards the owner writes through
    // `builtins`, which a session may spell and loaded code may not)
    await itx.cd(`${agentPath}/sandbox`).append(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx",
          target: null,
          description: "this agent's scripts get only the rows below",
        },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx.catalogue",
          target: "itx.builtins.cd('/').catalogue",
          description: "search the catalogue: itx.catalogue.search({ q })",
        },
      },
      {
        // a PHYSICAL grant to a library root: the verb runs HERE, its hops at the fixed point
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx.repos",
          target: "itx.builtins.repos",
          description: "the project's repos: itx.repos.list()",
        },
      },
    );
    await itx.cd(`${agentPath}/sandbox`).builtins.append(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.run", target: "itx.builtins.run" },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.rewriteRules", target: "itx.builtins.rewriteRules" },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.agents", target: null },
      },
    );
    const rootRulesBefore = await itx.rewriteRules.list();
    const sandboxRulesBefore = await itx.cd(`${agentPath}/sandbox`).builtins.rewriteRules.list();
    // The agent never outlives the test: a turn a failure cut short would otherwise run on after the
    // session's lend of the fake is gone — into the real model.
    try {
      await agent.message("Probe everything.");
      // THE TURN ENDS WITH THE FAKE'S LAST WORDS, and only then may the test end: its session lends the
      // model, so a test that ended at the tenth settlement dropped the lend under the agent's eleventh
      // request, which then went to the REAL default route (Workers AI) and kept probing — up to ten
      // billed turns after the test had passed (13 JAIL runs on a soak preview, 2026-09-24: 9 did).
      // The flake ends the wait at once (and the `finally` below deletes the agent, so a turn cut
      // short never reaches a real model either).
      const depthRefusalIn = (log: { offset: number; type: string; payload?: any }[]) =>
        log.find(
          (e) =>
            /\/(context\/run-settled|agent\/llm-request-settled)$/.test(e.type) &&
            JSON.stringify(e.payload).includes("Subrequest depth limit exceeded"),
        );
      const log = await until(
        "the probing turn's last words",
        async () => {
          const all = await readAll(support);
          return assistantWords(all).includes("Done probing.") ||
            all.some((e) => e.type === "events.iterate.com/agent/paused") ||
            depthRefusalIn(all)
            ? all
            : undefined;
        },
        60_000,
      ).catch(async (error: unknown) => {
        const all = await readAll(support);
        throw new Error(`${String(error)} — the turn so far: ${turnSummary(all)}`);
      });
      const depthRefusal = depthRefusalIn(log);
      if (depthRefusal)
        throw new Error(
          `the platform refused a hop at offset ${depthRefusal.offset}: Subrequest depth limit exceeded — the turn: ${turnSummary(log)}`,
        );
      const settled = log
        .filter((e) => e.type === "events.iterate.com/context/run-settled")
        .map((e) => e.payload.settlement as { status: string; result?: unknown; error?: string });
      expect(assistantWords(log).at(-1)).toBe("Done probing."); // the turn ended on the fake's words
      // a mismatch names every settlement — which script answered what
      expect(
        settled.map((s) => s.status),
        JSON.stringify(settled),
      ).toEqual([
        "failed",
        "failed",
        "failed",
        "succeeded",
        "failed",
        "failed",
        "failed",
        "failed",
        "succeeded",
        "succeeded",
      ]);
      expect(settled[0]!.error).toMatch(/is masked/); // kv: the bare null
      expect(settled[1]!.error).toMatch(/masked|goes down only/); // cd('/'): the wall, or the app rule
      expect(settled[2]!.error).toMatch(/not a loaded worker's word/); // itx.builtins
      expect(settled[3]).toMatchObject({ result: 404 }); // raw fetch: the expression fetch found no `itx.fetch` row
      expect(settled[4]!.error).toMatch(/is masked/); // the self-grant: append is masked
      expect(settled[5]!.error).toMatch(/is masked/); // schedules: masked
      expect(settled[6]!.error).toMatch(/is masked/); // a live lend over the grant: its row is an append, masked
      expect(settled[7]!.error).toMatch(/is masked/); // a live subscription: its row likewise
      expect(settled[8]).toMatchObject({ result: [{ name: "ship.com", price: 42 }] }); // the one grant, still the owner's
      expect(settled[9]).toMatchObject({ result: [] }); // the library root granted physically: its hops are the platform's
      // nothing moved: the root's table and the sandbox's are what the owner wrote
      expect(await itx.rewriteRules.list()).toEqual(rootRulesBefore);
      expect(await itx.cd(`${agentPath}/sandbox`).builtins.rewriteRules.list()).toEqual(
        sandboxRulesBefore,
      );
    } finally {
      await Promise.race([itx.agents.delete(agentPath).catch(() => undefined), sleep(5_000)]);
    }
  },
);

test("itx.agents.delete(path) lands the request and the death certificate on the agent's path AND on /, drops the processor row; message() refuses and the loop runs no more turns; a second delete answers at once; never created, nothing to delete; deleted, not re-creatable", async () => {
  const itx = await openAgentItx(freshCtx("agent-delete"));
  const agent = itx.agents.get("/agents/gone");

  await expect(itx.agents.delete("/agents/gone")).rejects.toThrow(
    /agent \/agents\/gone: not created — nothing to delete/,
  );
  expect(await itx.agents.create("/agents/gone")).toEqual({ path: "/agents/gone" });
  expect(await processorNames(itx.cd("/agents/gone"))).toEqual(["agent"]);

  expect(await itx.agents.delete("/agents/gone")).toEqual({ path: "/agents/gone" });
  const own = await readAll(itx.cd("/agents/gone"));
  expect(short(own)).toEqual([
    "agent/create-requested",
    "agent/created",
    "agent/context-added", // the default prompt, beside the birth certificate
    "agent/delete-requested",
    "agent/deleted",
  ]);
  expect(
    own.filter((e) => e.type === "events.iterate.com/agent/deleted").map((e) => e.payload),
  ).toEqual([{ path: "/agents/gone" }]);
  expect(short(await readAll(itx))).toEqual(["agent/created", "agent/deleted"]); // both certificates cross to /
  expect(await processorNames(itx.cd("/agents/gone"))).toEqual([]); // the row went

  // A person's words refuse — nothing lands, nothing is triggered, and no facet is hosted for the
  // dead agent: its facet went with its storage, and a refusal answers from the catalog on `/`
  // (runtime/collection.ts says why it must never host it again).
  await expect(agent.message("anyone there?")).rejects.toThrow(/agent \/agents\/gone: deleted/);
  expect(await readAll(itx.cd("/agents/gone"))).toHaveLength(own.length);
  const noAgentFacet = async () =>
    expect(errorCode(await rejection(itx.cd("/agents/gone").facets.get("agent").snapshot()))).toBe(
      "NO_FACET",
    );
  await noAgentFacet();
  // Words appended PAST the verb (the handle's typed append lands under the caller's principal, no
  // guard) raise no turn: no row, no facet, nothing folds them — no request is recorded long after
  // the debounce window (250 ms) would have closed.
  await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content: "anyone there?", actor: { type: "user" } },
  });
  await sleep(1_000);
  expect(short(await readAll(itx.cd("/agents/gone")))).toEqual([
    ...short(own),
    "agent/context-added",
  ]);

  // Dies once: a second delete answers at once and appends nothing; not re-creatable — neither
  // hosting the facet again.
  expect(await itx.agents.delete("/agents/gone")).toEqual({ path: "/agents/gone" });
  expect(short(await readAll(itx.cd("/agents/gone")))).toEqual([
    ...short(own),
    "agent/context-added",
  ]);
  await expect(itx.agents.create("/agents/gone")).rejects.toThrow(
    /agent \/agents\/gone: deleted — not re-creatable/,
  );
  await noAgentFacet();
  expect(await processorNames(itx.cd("/agents/gone"))).toEqual([]);
});

// A REFUSAL DOES NOT HOLD THE CONTEXT (apps/os e2e/context-residency.e2e.test.ts says why): the deleted
// agent refusing `message`, the collection on `/` refusing `create` — each held its context
// on its first incarnation, billed, long after the call (2026-09-23: 20 minutes after the suite). An
// idle context is evicted in ~10 s, so one woken after each of three 12 s idles shows three wakes.
// NOR DOES A REFUSAL HOST THE DEAD AGENT'S FACET AGAIN: when it did, the next incarnation's birth
// aborted that facet and Cloudflare reset the whole object — its first call failed "Internal error in
// Durable Object storage caused object to be reset" in about one CI run in fourteen
// (runtime/collection.ts). So no incarnation of the dead agent's context resets a facet at birth.
test("a deleted agent's refusals keep neither the root nor the agent's context resident", async () => {
  const ctx = freshCtx("agent-delete-residency");
  const itx = await openAgentItx(ctx);
  expect(await itx.agents.create("/agents/gone")).toEqual({ path: "/agents/gone" });
  expect(await itx.agents.delete("/agents/gone")).toEqual({ path: "/agents/gone" });
  await expect(itx.agents.get("/agents/gone").message("anyone there?")).rejects.toThrow(/deleted/);
  await expect(itx.agents.create("/agents/gone")).rejects.toThrow(/not re-creatable/);
  disposeSessions();
  const wakesAcrossIdles = async (context: any) => {
    for (let i = 0; i < 3; i++) {
      await sleep(12_000);
      await context.whoami();
    }
    return (await readAll(context)).filter(
      (event: { type: string }) => event.type === "events.iterate.com/stream/woken",
    );
  };
  const [rootWakes, agentWakes] = await Promise.all([
    wakesAcrossIdles(openItx(ctx)),
    wakesAcrossIdles(openItx(ctx).cd("/agents/gone")),
  ]);
  const wakes = [rootWakes.length, agentWakes.length];
  expect(Math.min(...wakes), JSON.stringify(wakes)).toBeGreaterThanOrEqual(3);
  expect(agentWakes.map((event) => event.payload.facetsReset ?? [])).toEqual(
    agentWakes.map(() => []),
  );
}, 90_000);

/** A turn's log as its loop facts — the settlements with what they said — for a failure message. */
function turnSummary(log: { offset: number; type: string; payload?: any }[]): string {
  return JSON.stringify(
    log
      .filter((e) => /\/(agent\/(llm-request-settled|paused)|context\/run-settled)$/.test(e.type))
      .map((e) => [
        e.offset,
        e.type.replace("events.iterate.com/", ""),
        e.payload?.settlement ?? e.payload?.result ?? e.payload,
      ]),
  );
}
