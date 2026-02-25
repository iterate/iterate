/* eslint-disable no-empty-pattern -- Playwright requires object-destructured fixture args. */
import { expect } from "@playwright/test";
import { projectDeployment, test } from "./test-helpers.ts";

test.describe("service load checks", () => {
  test("docs service loads and discovers events + orders OpenAPI sources", async ({}) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("orders");
    await deployment.startOnDemandProcess("docs");

    const docsHomeResponse = await deployment.request({
      host: "docs.iterate.localhost",
      path: "/",
    });
    expect(docsHomeResponse.status).toBe(200);
    expect(await docsHomeResponse.text()).toContain("jonasland API Docs");

    const sourcesPayload = await deployment.waitForDocsSources([
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

  test("outerbase service route loads", async ({}) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("outerbase");

    const response = await deployment.request({
      host: "outerbase.iterate.localhost",
      path: "/healthz",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"ok":true');
  });

  test("openobserve route loads", async ({}) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("openobserve");

    const openobserve = await deployment.request({
      host: "openobserve.iterate.localhost",
      path: "/",
    });
    expect(openobserve.status).toBeLessThan(400);
  });

  test("caddy manager route loads", async ({}) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("caddymanager");

    const health = await deployment.request({
      host: "caddymanager.iterate.localhost",
      path: "/healthz",
    });
    expect(health.status).toBe(200);
    const payload = (await health.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
