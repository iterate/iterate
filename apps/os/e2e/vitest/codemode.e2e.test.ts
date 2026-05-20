/**
 * E2E tests for codemode oRPC endpoints.
 * Runs against a live os deployment (dev or preview).
 *
 * Set OS_BASE_URL to the deployment URL before running:
 *   OS_BASE_URL=https://os.iterate-dev-jonas.com \
 *   OS_E2E_PROJECT_ID=proj_... \
 *   OS_E2E_COOKIE='__session=...' pnpm e2e -t codemode.executeScript
 */
import { expect, expectTypeOf, test } from "vitest";
import { createTestProjectFixture } from "../test-support/create-test-project.ts";
import { setupE2E } from "../test-support/e2e-test.ts";

test("starts a script immediately and reads output events from the stream path", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "foobar" });

  const started = await fixture.startCodemodeScript(async () => 1 + 1);

  expect(started.event.type).toBe("events.iterate.com/codemode/script-execution-requested");
  expect(started.streamPath).toBeTruthy();
  const { scriptExecutionId } = started.event.payload as { scriptExecutionId: string };

  const stream = await fixture.client.project.codemode.streamEvents({
    afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
    projectSlugOrId: fixture.project.id,
    streamPath: started.streamPath,
  });

  const events: Array<Record<string, unknown>> = [];
  for await (const event of stream) {
    events.push(event as Record<string, unknown>);
    const payload = event.payload as Record<string, unknown>;
    if (
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      payload.scriptExecutionId === scriptExecutionId
    ) {
      break;
    }
  }

  const finished = events.find(
    (event) => event.type === "events.iterate.com/codemode/script-execution-completed",
  );
  expect(finished?.payload).toMatchObject({
    outcome: { status: "returned", value: 2 },
    scriptExecutionId,
  });
});

test("runs codemode fetch through a Project Egress Intercept Tunnel", async (ctx) => {
  const e2e = await setupE2E(ctx);

  await using fixture = await createTestProjectFixture({
    slugPrefix: "mock-internet",
    egressFetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/__e2e-health") return new Response("ok");
      if (url.href.startsWith("https://example.com/os-e2e")) {
        const source = url.searchParams.get("source");
        return Response.json(
          { mocked: true, query: source, runSlug: e2e.runSlug },
          { headers: { "x-e2e-mocked": "yes" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });

  const completed = await fixture.executeCodemodeScript(async function () {
    const response = await fetch("https://example.com/os-e2e?source=codemode");
    return {
      body: (await response.json()) as { mocked: boolean; query: string; runSlug: string },
      mockedHeader: response.headers.get("x-e2e-mocked"),
      status: response.status,
    };
  });

  expectTypeOf(completed.payload).toExtend<{
    functionCallId: string;
    durationMs?: number;
    scriptExecutionId?: string;
  }>();
  expect(completed.snapshot({ runSlug: e2e.runSlug })).toMatchInlineSnapshot(`
    {
      "durationMs": 999,
      "functionCallId": "<function-call-id>",
      "outcome": {
        "status": "returned",
        "value": {
          "body": {
            "mocked": true,
            "query": "codemode",
            "runSlug": "<runSlug>",
          },
          "mockedHeader": "yes",
          "status": 200,
        },
      },
      "scriptExecutionId": "<script-execution-id>",
    }
  `);

  expect(completed.payload).toMatchObject({
    outcome: {
      status: "returned",
      value: {
        body: { mocked: true, query: "codemode", runSlug: e2e.runSlug },
        mockedHeader: "yes",
        status: 200,
      },
    },
    scriptExecutionId: completed.payload.scriptExecutionId,
  });
  expect(completed.events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-completed",
      payload: expect.objectContaining({
        path: ["fetch"],
      }),
    }),
  );
});

test("returns short provider instructions", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "provider-instructions" });

  const result = await fixture.client.project.codemode.describe({
    projectSlugOrId: fixture.project.id,
    providers: [
      {
        instructions: "Test functions are available.",
        invocation: { kind: "event" },
        path: ["test"],
      },
    ],
  });

  expect(result.instructions).toBe("test: Test functions are available.");
});
