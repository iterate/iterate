import { expect, test } from "vitest";
import { interceptor } from "@iterate-com/test-support";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("a test project's unconfigured agents and direct AI calls stay intercepted after handler release", async () => {
  using session = withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } });
  using project = await interceptor.createProject(
    session.projects.get(`test-ai-${crypto.randomUUID()}`),
  );
  const seen: any[] = [];
  using ai = await project.ai.intercept((call) => {
    seen.push(call);
    if (call.source === "agent-turn") {
      return interceptor.codemodeBackticksResponse(
        'async (itx) => { await itx.chat.sendMessage("scripted"); }',
        call,
      );
    }
    return Response.json({ response: "scripted direct call" });
  });

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
  await ai.release();
  await expect(
    project.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { prompt: "after teardown" }),
  ).rejects.toThrow("No AI interceptor installed");
});
