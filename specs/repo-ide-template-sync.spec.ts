import { test } from "./test-support/test.ts";

/**
 * The repo IDE's Template panel: every seeded repo durably records how it was
 * created (an `empty` create IS the Default template), the GitHub sidebar
 * shows that provenance, and "Update to latest template" runs
 * `repo.syncFromTemplate()` — a per-file three-way against the template at
 * the last sync whose toast reports what was updated and what was skipped
 * because the user edited it.
 */
test("the config repo shows its template provenance and re-syncs on demand", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("tpl-sync");

  await page.goto(`/projects/${fixture.project.slug}/repos/config`);
  page.videoMode?.setStartTime();

  // The Template panel lives in the GitHub sidebar view, above the link form.
  await page.getByRole("button", { name: "GitHub" }).click();
  await page.getByText("Created from").waitFor();
  await page.getByText("iterate/iterate/configs/default").waitFor();

  // Dumb button, no dry-run: the result toast is the report. A fresh project
  // is usually already up to date; template drift since the embedded seed
  // was generated shows as a small update instead — both are fine outcomes.
  await page.getByRole("button", { name: "Update to latest template" }).click();
  await page
    .getByText(/Already up to date with the template|Synced from template|Nothing to update/)
    .waitFor();

  // Every first sync records the template revision it read; the panel shows
  // it as the next sync's base.
  await page.getByText("Last synced @").waitFor();
});
