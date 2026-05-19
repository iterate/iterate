import { join } from "node:path";
import { HttpResponse, http } from "@iterate-com/mock-http-proxy";
import { expect, expectTypeOf, test } from "vitest";
import { createMockInternet } from "../test-support/create-mock-internet.ts";
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

    await using internet = await createMockInternet({
      harPath: join(e2e.artifactDir, "codemode-fetch.har"),
      handlers: [
        http.get("*/__e2e-health", () => HttpResponse.text("ok")),
        http.get("https://example.com/os-e2e", ({ request }) =>
          HttpResponse.json(
            {
              mocked: true,
              query: new URL(request.url).searchParams.get("source"),
              runSlug: e2e.runSlug,
            },
            {
              headers: {
                "x-e2e-mocked": "yes",
              },
            },
          ),
        ),
      ],
    });

    await using fixture = await createFixture({
      slugPrefix: "mock-internet",
    });
    await using _intercept = await useProjectEgressInterceptTunnel({
      baseUrl: fixture.baseUrl,
      fetch: internet.fetch,
      project: fixture.project,
    });

    const completed = await fixture.executeCodemodeScript(async function () {
      const response = await fetch("https://example.com/os-e2e?source=codemode");
      return {
        body: (await response.json()) as { mocked: boolean; query: string; runSlug: string },
        mockedHeader: response.headers.get("x-e2e-mocked"),
        status: response.status,
      };
    });

    const har = internet.getHar();

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
    expect(
      completed.events.filter((event) => event.type === "events.iterate.com/core/error-occurred"),
    ).toEqual([]);
    expect(
      har.log.entries
        .filter((entry) => !entry.request.url.endsWith("/__e2e-health"))
        .map((entry) => entry.request.url),
    ).toContain("https://example.com/os-e2e?source=codemode");
  },
);
