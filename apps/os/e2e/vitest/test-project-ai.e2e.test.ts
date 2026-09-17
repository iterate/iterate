import { expect, test } from "vitest";
import { interceptor } from "@iterate-com/test-support";
import { adminSecret, withItxSession } from "./test-helpers.ts";

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
    predicate: (event) => (event.payload.result as any)?.status === "succeeded",
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
