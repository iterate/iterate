import { expect, expectTypeOf, test } from "vitest";
import { createFixture } from "../test-support/create-test-project.ts";
import { setupE2E } from "../test-support/e2e-test.ts";
import { useProjectEgressInterceptTunnel } from "../test-support/project-egress-intercept-tunnel.ts";

const hasAdminApiTarget =
  !!(process.env.OS_BASE_URL?.trim() || process.env.APP_CONFIG_BASE_URL?.trim()) &&
  !!(
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim()
  );
const testIfAdminApiTarget = hasAdminApiTarget ? test : test.skip;

testIfAdminApiTarget(
  "runs codemode fetch through a Project Egress Intercept Tunnel",
  async (ctx) => {
    const e2e = await setupE2E(ctx);

    await using fixture = await createFixture({
      slugPrefix: "mock-internet",
    });
    using _intercept = await useProjectEgressInterceptTunnel({
      project: fixture.project,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/__e2e-health") return new Response("ok");
        if (url.hostname === "example.com") {
          if (url.pathname === "/os-e2e") {
            return Response.json(
              {
                mocked: true,
                query: url.searchParams.get("source"),
                runSlug: e2e.runSlug,
              },
              { headers: { "x-e2e-mocked": "yes" } },
            );
          }
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
          body: {
            mocked: true,
            query: "codemode",
            runSlug: e2e.runSlug,
          },
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
  },
);
