import { expect } from "@playwright/test";
import { test } from "./trace-fixture.ts";

test("browser request reaches a traced Durable Object", async ({ page, probe }) => {
  await page.goto(probe.url);
  await expect(page.locator("body")).toContainText('"ok":true');
});

test("API request retains a distinct span on retry", async ({ request, probe }, info) => {
  const result = await probe.apiRequest(request);
  expect(result).toMatchObject({ ok: true });
  // Deliberately fail once to prove the failed attempt survives and the retry gets its own span.
  expect(info.retry, "Intentional first-attempt failure in this experiment").toBe(1);
});
