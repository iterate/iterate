import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("can enter the dashboard with a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("dashboard");

  await page.goto("/projects");
  await page.getByRole("link", { name: fixture.project.slug }).waitFor();
});

test("opening OS returns to the most recently active project", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("recent-project", { projectCount: 2 });
  const recent = fixture.projects[1]!;

  await page.goto(`/projects/${recent.slug}`);
  await page.getByTestId("project-settings-panel").waitFor();
  await page.goto("/");

  expect(page.url()).toContain(`/projects/${recent.slug}`);
});
