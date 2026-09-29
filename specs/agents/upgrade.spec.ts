// The Agents app's upgrade (apps/agents projects.$slug.tsx, packages/ui app-build.tsx): a project on
// an older build main published sees it in the sidebar and upgrades to main's newest. The
// `agents-phone` project runs it again at a phone's width, where the sidebar is a sheet.
import { upgradeAgents } from "@iterate-com/agents/install";
import { pkgPrNewVersion } from "@iterate-com/shared/pkg-pr-new";
import { olderMainCommit } from "../test-support/published-builds.ts";
import { test } from "../test-support/test.ts";

// main's older builds predate agents run from the published config: their `installAgents` takes a
// source, so a project pinned at one cannot install them.
// parked: an older main build cannot run on this platform — revisit by 2026-10-05
test.skip("a project on an older agents build upgrades to main's newest from the sidebar", async ({
  page,
  baseURL,
  helpers,
  isMobile,
}) => {
  helpers.appOrigin("agents");
  await using fixture = await helpers.createFixture("agents-upgrade", { app: baseURL });
  // The default template pins this deployment's own build, so the older one is committed as the
  // operator: the same pin commit an upgrade makes.
  const older = await olderMainCommit(["@iterate-com/agents"]);
  await upgradeAgents(fixture.itx, pkgPrNewVersion("@iterate-com/agents", older));
  const build = page.getByRole("region", { name: "Agents build" });
  const openSidebar = async () => {
    await page.reload();
    // a phone's sidebar is a sheet, opened by the header's trigger
    if (isMobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  };

  await openSidebar();
  await build.getByText(`${older.slice(0, 7)}. Main has a newer one`).waitFor();
  await build.getByRole("button", { name: "Upgrade to the newest" }).click();
  await build.getByText(`Upgraded from ${older.slice(0, 7)} to `).waitFor();
  await build.getByText("the newest on main").waitFor();

  // the project runs the new build: the page reads it from the project again
  await openSidebar();
  await build.getByText("the newest on main").waitFor();
});
