import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The fake/* lane's ai-run path from very far away: a live handler installed
// over capnweb serves itx.ai.run("fake/…") with its return value verbatim,
// and a released (or never-installed) handler fails loudly instead of dialing
// anything. The agent-turn path is proven by specs/agent-fake-model-chat.spec.ts.
test("itx.ai.run('fake/…') is served by the live interceptor; releasing it makes the lane fail loudly", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`ai-intercept-${crypto.randomUUID()}`).create({});

  using interception = await project.ai.intercept(async ({ source, model, body }) => {
    return { served: { source, model, body } };
  });

  const result = await project.ai.run("fake/echo-args", { prompt: "ping" });
  expect(result).toMatchObject({
    served: { source: "ai-run", model: "fake/echo-args", body: { prompt: "ping" } },
  });

  await interception.release();
  await expect(project.ai.run("fake/echo-args", { prompt: "ping" })).rejects.toThrow(
    /No AI interceptor installed/,
  );
});
