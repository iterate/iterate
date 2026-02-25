import { expect } from "@playwright/test";
import { ingressRequest, startOnDemandProcess, test, waitForDocsSources } from "./test-helpers.ts";

test.describe("service load checks", () => {
  test("docs service loads and discovers events + orders OpenAPI sources", async ({
    deployment,
  }) => {
    await startOnDemandProcess(deployment, "orders");
    await startOnDemandProcess(deployment, "docs");

    const docsHomeResponse = await ingressRequest(deployment, {
      host: "docs.iterate.localhost",
      path: "/",
    });
    expect(docsHomeResponse.status).toBe(200);
    expect(await docsHomeResponse.text()).toContain("jonasland API Docs");

    const sourcesPayload = await waitForDocsSources(deployment, [
      "events.iterate.localhost",
      "orders.iterate.localhost",
    ]);

    expect(sourcesPayload.total).toBeGreaterThanOrEqual(2);
    expect(
      sourcesPayload.sources.some(
        (source) =>
          source.id === "events.iterate.localhost" && source.specUrl.endsWith("/api/openapi.json"),
      ),
    ).toBe(true);
    expect(
      sourcesPayload.sources.some(
        (source) =>
          source.id === "orders.iterate.localhost" && source.specUrl.endsWith("/api/openapi.json"),
      ),
    ).toBe(true);
  });

  test("outerbase service route loads", async ({ deployment }) => {
    await startOnDemandProcess(deployment, "outerbase");

    const response = await ingressRequest(deployment, {
      host: "outerbase.iterate.localhost",
      path: "/healthz",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"ok":true');
  });

  test("caddy manager route responds and typed caddy client can read config", async ({
    deployment,
  }) => {
    const navigateResponse = await ingressRequest(deployment, {
      host: "caddy-admin.iterate.localhost",
      path: "/config/",
      headers: {
        "sec-fetch-mode": "navigate",
      },
    });

    expect(navigateResponse.status).toBe(403);
    expect(await navigateResponse.text()).toContain("client is not allowed to access from origin");

    const config = await deployment.caddy.getConfig();
    expect(typeof config).toBe("object");
  });
});
