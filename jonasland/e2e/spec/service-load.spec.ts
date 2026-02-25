/* eslint-disable no-empty-pattern -- Playwright requires object-destructured fixture args. */
import { expect } from "@playwright/test";
import { projectDeployment, test } from "./test-helpers.ts";

test.describe("service load checks", () => {
  test("docs service loads and discovers events + orders OpenAPI sources", async ({ page }) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("orders");
    await deployment.startOnDemandProcess("docs");
    const ingressUrl = new URL(await deployment.ingressUrl());
    const docsBaseUrl = `http://docs.iterate.localhost:${ingressUrl.port}`;

    const docsHomeResponse = await page.goto(`${docsBaseUrl}/`);
    expect(docsHomeResponse).not.toBeNull();
    expect(docsHomeResponse?.status()).toBe(200);
    await expect(page).toHaveTitle("jonasland API Docs");

    await expect
      .poll(async () => {
        const response = await page.request.get(`${docsBaseUrl}/api/openapi-sources`);
        if (!response.ok()) return 0;
        const payload = (await response.json()) as {
          sources: Array<{ id: string; specUrl: string }>;
        };
        const expectedHosts = new Set(["events.iterate.localhost", "orders.iterate.localhost"]);
        const matched = payload.sources.filter(
          (source) => expectedHosts.has(source.id) && source.specUrl.endsWith("/api/openapi.json"),
        );
        return matched.length;
      })
      .toBe(2);
  });

  test("outerbase service route loads", async ({ page }) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("outerbase");
    const ingressUrl = new URL(await deployment.ingressUrl());

    const response = await page.goto(
      `http://outerbase.iterate.localhost:${ingressUrl.port}/healthz`,
    );
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText('"ok":true');
  });

  test("openobserve route loads", async ({ page }) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("openobserve");
    const ingressUrl = new URL(await deployment.ingressUrl());

    const openobserve = await page.goto(
      `http://openobserve.iterate.localhost:${ingressUrl.port}/`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect(openobserve).not.toBeNull();
    expect(openobserve?.status()).toBeLessThan(400);
  });

  test("caddy manager route loads", async ({ page }) => {
    await using deployment = await projectDeployment();
    await deployment.startOnDemandProcess("caddymanager");
    const ingressUrl = new URL(await deployment.ingressUrl());

    const health = await page.goto(
      `http://caddymanager.iterate.localhost:${ingressUrl.port}/healthz`,
    );
    expect(health).not.toBeNull();
    expect(health?.status()).toBe(200);
    await expect(page.locator("body")).toContainText('"ok":true');
  });
});
