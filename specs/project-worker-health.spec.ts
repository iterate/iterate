import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

/**
 * Worker error visibility, end to end in the incident's shape: a config repo
 * commit that breaks the worker build lands durably as
 * `project/worker-update-failed`, the sidebar renders it as a red warning,
 * and the warning's sheet cross-links to the config repo IDE — where the
 * Template panel (the incident's fix path) lives. The same sheet is where
 * the polled `itx.subscriptionHealth()` rollup reports halted/lagging child
 * streams; a fresh healthy project has none to show, so this walkthrough
 * shows the build-failure section.
 */
test("a broken config commit shows a red worker warning that leads to the fix", async ({
  helpers,
  page,
  baseURL,
}) => {
  // One real dynamic-worker build (bundler + package install) sits between
  // the breaking commit and the warning; the default budget cannot hold it.
  test.slow();
  await using fixture = await helpers.createFixture("worker-health");

  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(fixture.project.id);

  await page.goto(`/projects/${fixture.project.slug}`);
  page.videoMode?.setStartTime();

  // Break the build with an ordinary config commit — the platform reacts to
  // the commit fact, probes the worker, and journals the deterministic
  // failure on the project stream.
  await project.repo.commitFiles({
    changes: [
      {
        path: "worker.ts",
        content: 'import { missing } from "./does-not-exist.ts";\nexport default missing(',
      },
    ],
    message: "Break the worker build (spec)",
  });

  const warning = page.getByRole("button", { name: /Project worker build failed/ });
  // The readiness probe rebuilds the changed source (bundler + package
  // install) before it can fail, entirely server-side; the sidebar
  // deliberately shows nothing until the durable failure fact lands.
  // timeout justified: no in-page progress element exists for the spinner-waiter to extend on
  await warning.waitFor({ timeout: 150_000 });
  await warning.click();

  // The sheet names the failing commit and explains the blast radius.
  await page.getByText(/config repo @ [0-9a-f]{7}/).waitFor();
  await page.getByText("The project worker no longer builds").waitFor();

  // The incident-shaped fix path: straight to the config repo IDE, where the
  // Template panel's "Update to latest template" button lives.
  await page.getByRole("link", { name: "Open config repo" }).click();
  await page.getByRole("button", { name: "GitHub" }).click();
  await page.getByRole("button", { name: "Update to latest template" }).waitFor();
});
