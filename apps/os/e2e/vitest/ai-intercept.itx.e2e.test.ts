import { expect, test, vi } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The intercepted/* namespace's ai-run path from very far away: a live handler installed
// over capnweb serves itx.ai.run("intercepted/…") with a provider response decoded like a real call,
// and a released (or never-installed) handler fails loudly instead of dialing
// anything. The agent-turn path is proven by specs/agent-fake-model-chat.spec.ts.
test("itx.ai.run('intercepted/…') is served by the live interceptor; releasing it makes intercepted/* calls fail loudly", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`ai-intercept-${crypto.randomUUID()}`).create({});

  using interception = await project.ai.intercept(async (input) => {
    return Response.json({ served: input });
  });

  const result = await project.ai.run("intercepted/echo-args", { prompt: "ping" });
  expect(result).toMatchObject({
    served: {
      source: "ai-run",
      model: "intercepted/echo-args",
      request: { body: { prompt: "ping" } },
    },
  });

  await interception.release();
  await expect(project.ai.run("intercepted/echo-args", { prompt: "ping" })).rejects.toThrow(
    /No AI interceptor installed/,
  );
});

test("ai.run decodes JSON, preserves binary/SSE streams and raw responses, and rejects HTTP errors", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ai-response-${crypto.randomUUID()}`).create({});
  using _interception = await project.ai.intercept(async (call) => {
    expect(call.request).toMatchObject({
      kind: "workers-ai",
      model: "test-model",
      options: { returnRawResponse: true, gateway: { id: "test-gateway", skipCache: true } },
    });
    return new Response(call.request.body.body as any, call.request.body);
  });
  const options = { gateway: { id: "test-gateway", skipCache: true } };
  expect(
    await project.ai.run(
      "intercepted/test-model",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "test-result" }),
      },
      options,
    ),
  ).toMatchObject({ value: "test-result" });
  for (const contentType of [
    "application/octet-stream",
    "text/event-stream",
    "application/json; charset=utf-8",
  ]) {
    const stream: any = await project.ai.run(
      "intercepted/test-model",
      {
        status: 200,
        headers: { "content-type": contentType },
        body: "test-bytes",
      },
      options,
    );
    expect(await new Response(stream).text()).toBe("test-bytes");
  }
  const empty: any = await project.ai.run(
    "intercepted/test-model",
    { status: 200, headers: { "content-type": "application/octet-stream" }, body: "" },
    options,
  );
  expect(await new Response(empty).text()).toBe("");
  const failed = {
    status: 503,
    headers: { "content-type": "application/json" },
    body: '{"error":"test-failure"}',
  };
  await expect(project.ai.run("intercepted/test-model", failed, options)).rejects.toThrow(
    /503.*test-failure/,
  );
  const raw: any = await project.ai.run("intercepted/test-model", failed, {
    ...options,
    returnRawResponse: true,
  });
  expect(raw).toMatchObject({ status: 503 });
  expect(await raw.json()).toMatchObject({ error: "test-failure" });
  await expect(
    project.ai.run("intercepted/test-model", { status: 204, headers: {}, body: null }, options),
  ).rejects.toThrow(/204/);
  const noContent: any = await project.ai.run(
    "intercepted/test-model",
    { status: 204, headers: {}, body: null },
    { ...options, returnRawResponse: true },
  );
  expect(noContent).toMatchObject({ status: 204, body: null });
});

test.for(["close", "cancel", "error", "disconnect"])(
  "interceptor SSE streams over RPC (%s)",
  async (ending) => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(`ai-stream-${crypto.randomUUID()}`).create({});
    const description = await project.__describe();
    using provider = withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } });
    using providerProject = provider.projects.get(description.projectId);
    const cancelled = Promise.withResolvers<unknown>();
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    using _interception = await providerProject.ai.intercept(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              producer = controller;
              controller.enqueue(encoder.encode('data: {"response":"first"}\n\n'));
            },
            cancel(reason) {
              cancelled.resolve(reason);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const response: any = await project.ai.run(
      "intercepted/test-stream",
      {},
      { returnRawResponse: true },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    try {
      expect(await reader.read()).toMatchObject({
        done: false,
        value: 'data: {"response":"first"}\n\n',
      });
      // The second event does not exist until the first has crossed every RPC hop.
      producer.enqueue(encoder.encode('data: {"response":"second"}\n\n'));
      expect(await reader.read()).toMatchObject({
        done: false,
        value: 'data: {"response":"second"}\n\n',
      });
      switch (ending) {
        case "close":
          producer.close();
          expect(await reader.read()).toMatchObject({ done: true });
          break;
        case "cancel":
          await reader.cancel("test consumer finished");
          await cancelled.promise;
          break;
        case "error":
          producer.error(new Error("test producer failed"));
          await expect(reader.read()).rejects.toThrow("test producer failed");
          break;
        case "disconnect":
          provider[Symbol.dispose]();
          await expect(reader.read()).rejects.toThrow();
          await cancelled.promise;
          break;
      }
    } finally {
      // An errored reader rejects cancellation too; release its lock regardless.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
);

test.for(["plain object", "consumed body", "locked body"])(
  "invalid interceptor response rejects without losing the session (%s)",
  async (invalid) => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(`ai-invalid-${crypto.randomUUID()}`).create({});
    let lockedReader: ReadableStreamDefaultReader | undefined;
    using _interception = await project.ai.intercept(async (call) => {
      if (!call.request.body.invalid) return Response.json({ healthy: true });
      if (invalid === "plain object") return { body: "invalid" } as any;
      const response = Response.json({ value: "test" });
      if (invalid === "consumed body") await response.text();
      if (invalid === "locked body") lockedReader = response.body!.getReader();
      return response;
    });
    try {
      await expect(project.ai.run("intercepted/test-model", { invalid: true })).rejects.toThrow(
        /Response|locked|consumed|used/,
      );
      expect(await project.ai.run("intercepted/test-model", {})).toMatchObject({ healthy: true });
    } finally {
      await lockedReader?.cancel();
      lockedReader?.releaseLock();
    }
  },
);

// The interceptor is a live capability mount on the root scope, so
// churn recovery is the shipped mount invariant — no interceptor-specific transport exists. The DO
// whose death matters is the ROOT STREAM DO (capability host + Pager parent):
// killing it closes the installing session with the existing pager-lost 4901,
// and the client's one recovery loop — reconnect, intercept() again —
// restores service. Consult latency is also logged here, crudely.
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
  using _interception = await interceptorProject.ai.intercept(async ({ model }) =>
    Response.json({ servedBy: "first install", model }),
  );
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
    .catch(() => {});

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
  using _recovered = await recoveredProject.ai.intercept(async () =>
    Response.json({ servedBy: "re-install" }),
  );
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "re-install" });
});

// Last-writer-wins maps to provide-at-same-path replacement, and the
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
  using first = await firstProject.ai.intercept(async () => Response.json({ servedBy: "first" }));

  using _second = await project.ai.intercept(async () => Response.json({ servedBy: "second" }));
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "second" });

  // The superseded handle is inert: releasing it must not tear down the winner.
  await first.release();
  expect(await project.ai.run("intercepted/echo", {})).toMatchObject({ servedBy: "second" });
});
