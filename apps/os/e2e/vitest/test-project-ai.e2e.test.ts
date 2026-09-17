import { expect, test } from "vitest";
import { interceptor } from "@iterate-com/test-support";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("the default test responder survives stream restart without closing the test session", async () => {
  const slug = `durable-test-ai-${crypto.randomUUID()}`;
  using session = withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } });
  using project = await interceptor.createProject(session.projects.get(slug));
  using root = project.streams.get("/");
  await expect(root.kill()).rejects.toThrow(/kill requested/i);

  using agent = project.agents.get("/agents/mobile/note-after-restart");
  await agent.create();
  const message = await agent.message("An unasserted background message");
  const settled = await agent.stream.waitForEvent({
    afterOffset: message.offset,
    eventTypes: ["events.iterate.com/agent/llm-request-settled"],
    timeoutMs: 30_000,
  });
  expect(settled.payload).toMatchObject({ result: { status: "succeeded" } });
  await expect(
    project.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { prompt: "hi" }),
  ).rejects.toThrow("Test must script its ai-run response");
});

test("a signup fixture without an email claim is intercepted from project birth", async () => {
  using session = withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } });
  // No explicit policy: mobile OAuth's access token has no email claim.
  using project = await session.projects
    .get(`intercepted-e2e-mobile-${crypto.randomUUID()}`)
    .create({});
  expect((await project.processor.snapshot()).state.createRequest?.config.aiPolicy).toEqual({
    liveAgentPaths: [],
  });
  using _ai = await interceptor.intercept(project, () => Response.json({ response: "scripted" }));
  expect(await project.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { prompt: "hi" })).toEqual(
    { response: "scripted" },
  );
});

test("a test project's unconfigured agents and direct AI calls stay intercepted after handler release", async () => {
  using session = withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } });
  using project = await interceptor.createProject(
    session.projects.get(`test-ai-${crypto.randomUUID()}`),
  );
  const seen: any[] = [];
  using ai = await interceptor.intercept(project, (call) => {
    seen.push(call);
    if (call.source === "agent-turn") {
      return interceptor.codemodeBackticksResponse(
        'async (itx) => { await itx.chat.sendMessage("scripted"); }',
        call,
      );
    }
    return Response.json({ response: "scripted direct call" });
  });

  using background = project.agents.get("/agents/onboarding");
  await background.create();
  const backgroundMessage = await background.message("Unrelated background turn");
  await background.stream.waitForEvent({
    afterOffset: backgroundMessage.offset,
    eventTypes: ["events.iterate.com/agent/llm-request-settled"],
    predicate: (event) => (event.payload?.result as any)?.status === "succeeded",
    timeoutMs: 30_000,
  });
  expect(seen).toEqual([]);

  // Born through ordinary application code, without createAgent() or a configured event.
  using agent = project.agents.get("/agents/mobile/note-test");
  await agent.create();
  expect(await agent.ask({ message: "hello" })).toMatchObject({ payload: { message: "scripted" } });
  const requests = await agent.stream.getEvents({
    eventTypes: ["events.iterate.com/agent/llm-request-requested"],
  });
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ model: "intercepted/openai/gpt-5.6-terra" }),
      }),
    ]),
  );

  expect(
    await project.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { prompt: "hello" }),
  ).toMatchObject({ response: "scripted direct call" });
  expect(seen).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "ai-run",
        model: "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct",
      }),
    ]),
  );
  console.info("[intercepted-project-proof]", {
    projectId: (await project.__describe()).projectId,
    observed: seen.map((call) => ({
      source: call.source,
      model: call.model,
      agentPath: call.agentPath,
    })),
  });
  await ai.release();
  await expect(
    project.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { prompt: "after teardown" }),
  ).rejects.toThrow("No AI interceptor installed");
});
