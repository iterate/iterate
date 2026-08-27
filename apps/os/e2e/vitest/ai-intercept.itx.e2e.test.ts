import { expect, test, vi } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The intercepted/* namespace's ai-run path from very far away: a live handler installed
// over capnweb serves itx.ai.run("intercepted/…") with its return value verbatim,
// and a released (or never-installed) handler fails loudly instead of dialing
// anything. The agent-turn path is proven by specs/agent-fake-model-chat.spec.ts.
test("itx.ai.run('intercepted/…') is served by the live interceptor; releasing it makes intercepted/* calls fail loudly", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`ai-intercept-${crypto.randomUUID()}`).create({});

  using interception = await project.ai.intercept(async ({ source, model, body }) => {
    return { served: { source, model, body } };
  });

  const result = await project.ai.run("intercepted/echo-args", { prompt: "ping" });
  expect(result).toMatchObject({
    served: { source: "ai-run", model: "intercepted/echo-args", body: { prompt: "ping" } },
  });

  await interception.release();
  await expect(project.ai.run("intercepted/echo-args", { prompt: "ping" })).rejects.toThrow(
    /No AI interceptor installed/,
  );
});

// The mount invariant, extended to interceptors (interceptor-liveness.ts): the
// handler slot is memory on the Project Durable Object, so a DO restart drops
// it — and before this lane existed, dropped it SILENTLY while the installing
// session's socket stayed open (the cold-preview failure mode where agent
// turns burned all 3 retries on "No AI interceptor installed"). Now the loss
// arrives as a close event: the installing session dies with 4901, and the
// client's one recovery loop — reconnect, intercept() again — restores service.
test("a Project DO restart closes the installing session with 4901; reconnect + re-install restores interception", async () => {
  using driver = withItxSession();
  using itx = driver.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ai-intercept-revival-${crypto.randomUUID()}`).create({});
  const description = await project.__describe();

  const closes: { code: number; reason: string }[] = [];
  using interceptorSession = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    onWebSocketClose: (close) => closes.push(close),
  });
  using interceptorProject = interceptorSession.projects.get(description.projectId);
  using _interception = await interceptorProject.ai.intercept(async ({ model }) => ({
    servedBy: "first install",
    model,
  }));
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({
    servedBy: "first install",
  });

  // The DO restart. kill() aborts the incarnation, which rejects its own RPC.
  await project.kill().catch(() => undefined);

  // The invariant's whole point: the installing session LEARNS, as a close
  // event with the documented code, instead of staying open and unintercepted.
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(closes[0]).toMatchObject({ code: 4901 });
  expect(closes[0]!.reason).toMatch(/interceptor lost/);

  // The revived incarnation's slot is honestly empty — a loud error, not a
  // broken stub hanging.
  await expect(project.ai.run("intercepted/echo", {})).rejects.toThrow(
    /No AI interceptor installed/,
  );

  // The client's recovery loop: reconnect, intercept() again, back in business.
  using recoveredSession = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
  });
  using recoveredProject = recoveredSession.projects.get(description.projectId);
  using _recovered = await recoveredProject.ai.intercept(async () => ({
    servedBy: "re-install",
  }));
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "re-install" });
});

// Deliberate teardown must stay SILENT: supersession (last writer wins) closes
// the loser's liveness socket with a recognized reason, and the loser's
// session must NOT be torn down — a superseded session firing its reconnect
// loop would fight the newer interceptor forever.
test("supersession by a newer interceptor does not close the superseded session", async () => {
  using driver = withItxSession();
  using itx = driver.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`ai-intercept-supersede-${crypto.randomUUID()}`)
    .create({});
  const description = await project.__describe();

  const closes: { code: number; reason: string }[] = [];
  using firstSession = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    onWebSocketClose: (close) => closes.push(close),
  });
  using firstProject = firstSession.projects.get(description.projectId);
  using _first = await firstProject.ai.intercept(async () => ({ servedBy: "first" }));

  using _second = await project.ai.intercept(async () => ({ servedBy: "second" }));
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "second" });

  // The superseded session is alive and useful — proven by a real round-trip
  // through it, not by the absence of a close event alone.
  expect(await firstProject.__describe()).toMatchObject({ projectId: description.projectId });
  expect(closes).toEqual([]);
});
