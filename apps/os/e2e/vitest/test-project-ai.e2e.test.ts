import { interceptor } from "@iterate-com/test-support";
import { expect, test } from "vitest";
import { bakeProjectWorkerRunner } from "../examples/example-matrix.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test.for(["default", "examples matrix"])(
  "%s configuration intercepts onboarding and a newly created agent",
  async (template) => {
    using session = withItxSession();
    using root = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await interceptor.createProject(
      root.projects.get(`scripted-project-${crypto.randomUUID().slice(0, 8)}`),
    );
    if (template === "examples matrix") {
      const { projectId } = await project.identity();
      await bakeProjectWorkerRunner({ examples: [], projectId });
    }
    const calls: string[] = [];
    using _ai = await interceptor.intercept(project, (call) => {
      if (call.source !== "agent-turn") throw new Error(`Unexpected ${call.source} call`);
      calls.push(call.model);
      return interceptor.codemodeBackticksResponse(
        'async (itx) => { await itx.chat.sendMessage("Scripted reply"); }',
        call,
      );
    });
    using agent = project.agents.get("/agents/configured-by-test-project");
    await agent.create();
    expect(await agent.ask({ message: "Hello" })).toMatchObject({
      type: "events.iterate.com/agents/web-message-sent",
      payload: { message: "Scripted reply" },
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const model of calls) expect(model).toMatch(/^intercepted\//);
    for (const path of ["/agents/onboarding", "/agents/configured-by-test-project"]) {
      const requests = await project.streams
        .get(path)
        .getEvents({ eventTypes: ["events.iterate.com/agent/llm-request-requested"] });
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests)
        expect(request.payload).toMatchObject({ model: expect.stringMatching(/^intercepted\//) });
    }
  },
);
