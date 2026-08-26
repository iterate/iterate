import { test } from "./test-support/test.ts";

/**
 * The repo IDE's Template provenance row: every seeded repo durably records
 * how it was created (an `empty` create IS the Default template), and the
 * GitHub sidebar shows that provenance. Display only — re-syncing against a
 * template is an admin script (apps/os/docs/worker-health-runbook.md), not a
 * button.
 */
test("the config repo shows its template provenance", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("tpl-prov");

  await page.goto(`/projects/${fixture.project.slug}/repos/config`);
  page.videoMode?.setStartTime();

  await page.getByRole("button", { name: "GitHub" }).click();
  await page.getByText("Created from").waitFor();
  await page.getByText("iterate/iterate/configs/default").waitFor();
});
