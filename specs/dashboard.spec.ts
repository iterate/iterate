import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("can enter the dashboard with a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("dashboard");

  await page.goto("/projects");
  await page.getByRole("link", { name: fixture.project.slug }).waitFor();
});

// Quarantined by tasks/quarantined-preview-e2e-retry-flakes.md.
test.skip("loads project navigation only when it opens", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("lazy-project-navigation");
  const dialogRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("command-palette-dialog")) dialogRequests.push(request.url());
  });

  await page.goto(`/projects/${fixture.project.slug}`);
  await page.getByTestId("project-dashboard").waitFor();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  expect(dialogRequests).toEqual([]);

  // Non-stream pages (the dashboard) use the shell "Navigate ⌘K" control;
  // stream pages expose a path pill like "/ ⌘K" instead.
  await page.getByRole("button", { name: /Navigate/ }).click();
  await page.getByRole("dialog", { name: "Project navigation" }).waitFor();

  expect(dialogRequests).toHaveLength(1);
});

// Quarantined by tasks/quarantined-preview-e2e-retry-flakes.md.
test.skip("opening OS returns to the most recently active project", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("recent-project", { projectCount: 2 });
  const recent = fixture.projects[1]!;

  await page.goto(`/projects/${recent.slug}`);
  await page.getByTestId("project-dashboard").waitFor();
  await page.goto("/");

  expect(page.url()).toContain(`/projects/${recent.slug}`);
});

test("project settings is available under /settings", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("project-settings");

  await page.goto(`/projects/${fixture.project.slug}/settings`);
  await page.getByTestId("project-settings-panel").waitFor();
  expect(page.url()).toContain(`/projects/${fixture.project.slug}/settings`);
});
