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

  test("openobserve route loads", async ({ deployment }) => {
    await startOnDemandProcess(deployment, "openobserve");

    const openobserve = await ingressRequest(deployment, {
      host: "openobserve.iterate.localhost",
      path: "/",
    });
    expect(openobserve.status).toBeLessThan(400);
  });

  test("caddy manager route loads", async ({ deployment }) => {
    await startOnDemandProcess(deployment, "caddymanager");

    const health = await ingressRequest(deployment, {
      host: "caddymanager.iterate.localhost",
      path: "/healthz",
    });
    expect(health.status).toBe(200);
    const payload = (await health.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
