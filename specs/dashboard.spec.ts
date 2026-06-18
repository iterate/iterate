import { test } from "./test-support/test.ts";

test("can enter the dashboard with a forged session", async ({ createProjectFixture, page }) => {
  await using projectFixture = await createProjectFixture("dashboard");

  await page.goto("/projects");
  await page.getByRole("link", { name: projectFixture.project.slug }).waitFor();
});
