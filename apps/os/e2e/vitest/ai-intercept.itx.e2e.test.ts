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

// SPIKE: the interceptor is a live capability mount on the root scope, so
// churn recovery is the shipped mount invariant, not a bespoke lane. The DO
// whose death matters is the ROOT STREAM DO (capability host + Pager parent):
// killing it closes the installing session with the existing pager-lost 4901,
// and the client's one recovery loop — reconnect, intercept() again —
// restores service. Consult-latency is also measured here, crudely, for the
// spike's verdict.
test("a root stream DO restart closes the installing session with 4901; reconnect + re-install restores interception", async () => {
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
  const consultStart = performance.now();
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({
    servedBy: "first install",
  });
  console.log(`[spike] one consult round-trip: ${Math.round(performance.now() - consultStart)}ms`);

  // The DO restart that matters in this design: the root stream (capability
  // host facet + the Pager's parent). kill() aborts the incarnation.
  await project.streams
    .get("/")
    .kill()
    .catch(() => undefined);

  // The mount invariant, via the SHIPPED machinery: pager loss closes the
  // installing session — no interceptor-specific carrier exists at all.
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(closes[0]).toMatchObject({ code: 4901 });

  // While nobody serves the mount, intercepted calls fail loudly.
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

// SPIKE: last-writer-wins maps to provide-at-same-path replacement, and the
// loser's offset-keyed handle can never revoke the winner's mount.
test("a newer intercept() supersedes the older one; the older handle's release cannot evict it", async () => {
  using driver = withItxSession();
  using itx = driver.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`ai-intercept-supersede-${crypto.randomUUID()}`)
    .create({});
  const description = await project.__describe();

  using firstSession = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
  });
  using firstProject = firstSession.projects.get(description.projectId);
  using first = await firstProject.ai.intercept(async () => ({ servedBy: "first" }));

  using _second = await project.ai.intercept(async () => ({ servedBy: "second" }));
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "second" });

  // The superseded handle is inert: releasing it must not tear down the winner.
  await first.release();
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "second" });
});
