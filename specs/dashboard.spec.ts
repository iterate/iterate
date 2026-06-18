import { test } from "./test-support/test.ts";

test("can enter the dashboard with a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("dashboard");

  await page.goto("/projects");
  await page.getByRole("link", { name: fixture.project.slug }).waitFor();
});
