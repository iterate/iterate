import { createFailing } from "@iterate-com/shared/test-support/failing-test";
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

  const result = await race(project.ai.run("intercepted/echo-args", { prompt: "ping" }), 2000);
  expect(result).toMatchObject({
    served: {
      source: "ai-run",
      model: "intercepted/echo-args",
      request: { body: { prompt: "ping" } },
    },
  });

  await interception.release();
  await expect(
    race(project.ai.run("intercepted/echo-args", { prompt: "ping" }), 2000),
  ).rejects.toThrow(/No AI interceptor installed/);
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
    await race(
      project.ai.run(
        "intercepted/test-model",
        {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "test-result" }),
        },
        options,
      ),
      2000,
    ),
  ).toMatchObject({ value: "test-result" });
  for (const contentType of [
    "application/octet-stream",
    "text/event-stream",
    "application/json; charset=utf-8",
  ]) {
    const stream: any = await race(
      project.ai.run(
        "intercepted/test-model",
        {
          status: 200,
          headers: { "content-type": contentType },
          body: "test-bytes",
        },
        options,
      ),
      2000,
    );
    expect(await new Response(stream).text()).toBe("test-bytes");
  }
  const empty: any = await race(
    project.ai.run(
      "intercepted/test-model",
      { status: 200, headers: { "content-type": "application/octet-stream" }, body: "" },
      options,
    ),
    2000,
  );
  expect(await new Response(empty).text()).toBe("");
  const failed = {
    status: 503,
    headers: { "content-type": "application/json" },
    body: '{"error":"test-failure"}',
  };
  await expect(
    race(project.ai.run("intercepted/test-model", failed, options), 2000),
  ).rejects.toThrow(/503.*test-failure/);
  const raw: any = await race(
    project.ai.run("intercepted/test-model", failed, {
      ...options,
      returnRawResponse: true,
    }),
    2000,
  );
  expect(raw).toMatchObject({ status: 503 });
  expect(await raw.json()).toMatchObject({ error: "test-failure" });
  await expect(
    race(
      project.ai.run("intercepted/test-model", { status: 204, headers: {}, body: null }, options),
      2000,
    ),
  ).rejects.toThrow(/204/);
  const noContent: any = await race(
    project.ai.run(
      "intercepted/test-model",
      { status: 204, headers: {}, body: null },
      { ...options, returnRawResponse: true },
    ),
    2000,
  );
  expect(noContent).toMatchObject({ status: 204, body: null });
});

test("streams SSE chunks over RPC and finishes when the producer closes", async () => {
  await using interception = await createStreamInterception();
  const response: any = await race(
    interception.project.ai.run("intercepted/test-stream", {}, { returnRawResponse: true }),
    2000,
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = interception.createReader(response);
  expect(await race(reader.read(), 2000)).toMatchObject({
    done: false,
    value: 'data: {"response":"first"}\n\n',
  });
  // The second event does not exist until the first has crossed every RPC hop.
  interception.producer.enqueue(new TextEncoder().encode('data: {"response":"second"}\n\n'));
  expect(await race(reader.read(), 2000)).toMatchObject({
    done: false,
    value: 'data: {"response":"second"}\n\n',
  });
  interception.producer.close();
  expect(await race(reader.read(), 2000)).toMatchObject({ done: true });
});

createFailing(test, /producer should observe cancellation/)(
  "cancelling an SSE reader cancels the interceptor producer",
  async () => {
    await using interception = await createStreamInterception();
    const response: any = await race(
      interception.project.ai.run("intercepted/test-stream", {}, { returnRawResponse: true }),
      2000,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = interception.createReader(response);
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"first"}\n\n',
    });
    // The second event does not exist until the first has crossed every RPC hop.
    interception.producer.enqueue(new TextEncoder().encode('data: {"response":"second"}\n\n'));
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"second"}\n\n',
    });
    await race(reader.cancel("test consumer finished"), 2000);
    await race(interception.cancelled.promise, 2000).catch((cause) => {
      throw new Error("producer should observe cancellation", { cause });
    });
  },
);

createFailing(test, /ReadableStream received over RPC disc/)(
  "an SSE producer error reaches the reader",
  async () => {
    await using interception = await createStreamInterception();
    const response: any = await race(
      interception.project.ai.run("intercepted/test-stream", {}, { returnRawResponse: true }),
      2000,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = interception.createReader(response);
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"first"}\n\n',
    });
    // The second event does not exist until the first has crossed every RPC hop.
    interception.producer.enqueue(new TextEncoder().encode('data: {"response":"second"}\n\n'));
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"second"}\n\n',
    });
    interception.producer.error(new Error("test producer failed"));
    await expect(race(reader.read(), 2000)).rejects.toThrow("test producer failed");
  },
);

createFailing(test, /producer should observe cancellation/)(
  "disconnecting the interceptor session errors the reader and cancels the producer",
  async () => {
    await using interception = await createStreamInterception();
    const response: any = await race(
      interception.project.ai.run("intercepted/test-stream", {}, { returnRawResponse: true }),
      2000,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = interception.createReader(response);
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"first"}\n\n',
    });
    // The second event does not exist until the first has crossed every RPC hop.
    interception.producer.enqueue(new TextEncoder().encode('data: {"response":"second"}\n\n'));
    expect(await race(reader.read(), 2000)).toMatchObject({
      done: false,
      value: 'data: {"response":"second"}\n\n',
    });
    interception.provider[Symbol.dispose]();
    await expect(race(reader.read(), 2000)).rejects.toThrow(/disconnected|closed/i);
    await race(interception.cancelled.promise, 2000).catch((cause) => {
      throw new Error("producer should observe cancellation", { cause });
    });
  },
);

test("an interceptor returning a plain object rejects without losing the session", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ai-invalid-${crypto.randomUUID()}`).create({});
  using _interception = await project.ai.intercept(async (call) => {
    if (!call.request.body.invalid) return Response.json({ healthy: true });
    return { body: "invalid" } as any;
  });
  await expect(
    race(project.ai.run("intercepted/test-model", { invalid: true }), 2000),
  ).rejects.toThrow(/Response|locked|consumed|used/);
  expect(await race(project.ai.run("intercepted/test-model", {}), 2000)).toMatchObject({
    healthy: true,
  });
});

createFailing(
  test,
  /expected .*Response\|locked\|consumed\|used.*Promise did not settle within 2000ms/,
)("an interceptor returning a consumed body rejects without losing the session", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ai-invalid-${crypto.randomUUID()}`).create({});
  using _interception = await project.ai.intercept(async (call) => {
    if (!call.request.body.invalid) return Response.json({ healthy: true });
    const response = Response.json({ value: "test" });
    await response.text();
    return response;
  });
  await expect(
    race(project.ai.run("intercepted/test-model", { invalid: true }), 2000),
  ).rejects.toThrow(/Response|locked|consumed|used/);
  expect(await race(project.ai.run("intercepted/test-model", {}), 2000)).toMatchObject({
    healthy: true,
  });
});

createFailing(
  test,
  /expected .*Response\|locked\|consumed\|used.*Promise did not settle within 2000ms/,
)("an interceptor returning a locked body rejects without losing the session", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ai-invalid-${crypto.randomUUID()}`).create({});
  const response = Response.json({ value: "test" });
  const lockedReader = response.body!.getReader();
  using _interception = await project.ai.intercept(async (call) => {
    if (!call.request.body.invalid) return Response.json({ healthy: true });
    return response;
  });
  try {
    await expect(
      race(project.ai.run("intercepted/test-model", { invalid: true }), 2000),
    ).rejects.toThrow(/Response|locked|consumed|used/);
    expect(await race(project.ai.run("intercepted/test-model", {}), 2000)).toMatchObject({
      healthy: true,
    });
  } finally {
    await race(lockedReader.cancel(), 2000).finally(() => lockedReader.releaseLock());
  }
});

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
  expect(await race(project.ai.run("intercepted/echo", {}), 2000)).toMatchObject({
    servedBy: "first install",
  });
  console.log(`[spike] one consult round-trip: ${Math.round(performance.now() - consultStart)}ms`);

  // The DO restart that matters in this design: the root stream (capability
  // host facet + the Pager's parent). kill() aborts the incarnation.
  await race(
    project.streams
      .get("/")
      .kill()
      .catch(() => {}),
    2000,
  );

  // The mount invariant, via the SHIPPED machinery: pager loss closes the
  // installing session — no interceptor-specific carrier exists at all.
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(closes[0]).toMatchObject({ code: 4901 });

  // While nobody serves the mount, intercepted calls fail loudly.
  await expect(race(project.ai.run("intercepted/echo", {}), 2000)).rejects.toThrow(
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
  expect(await race(project.ai.run("intercepted/echo", {}), 2000)).toMatchObject({
    servedBy: "re-install",
  });
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
  expect(await race(project.ai.run("intercepted/echo", {}), 2000)).toMatchObject({
    servedBy: "second",
  });

  // The superseded handle is inert: releasing it must not tear down the winner.
  await first.release();
  expect(await race(project.ai.run("intercepted/echo", {}), 2000)).toMatchObject({
    servedBy: "second",
  });
});

async function createStreamInterception() {
  await using resources = new AsyncDisposableStack();
  const session = resources.use(withItxSession());
  const itx = resources.use(session.authenticate({ type: "admin-secret", secret: adminSecret() }));
  const project = resources.use(
    await itx.projects.get(`ai-stream-${crypto.randomUUID()}`).create({}),
  );
  const description = await project.__describe();
  const provider = resources.use(
    withItxSession({ auth: { type: "admin-secret", secret: adminSecret() } }),
  );
  const providerProject = resources.use(provider.projects.get(description.projectId));
  const cancelled = Promise.withResolvers<unknown>();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller;
      controller.enqueue(new TextEncoder().encode('data: {"response":"first"}\n\n'));
    },
    cancel(reason) {
      cancelled.resolve(reason);
    },
  });
  resources.use(
    await providerProject.ai.intercept(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ),
  );
  const interception = Object.assign(resources.move(), {
    project,
    producer,
    provider,
    cancelled,
    createReader(response: any) {
      const reader: ReadableStreamDefaultReader<string> = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      interception.defer(() =>
        race(
          reader.cancel().catch(() => {}),
          2000,
        ).finally(() => reader.releaseLock()),
      );
      return reader;
    },
  });
  return interception;
}

async function race<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
