// Voice's upgrade (apps/voice projects.$slug.tsx, packages/ui app-build.tsx): a project on an older
// voice build main published sees it under Call and upgrades to main's newest. The `voice-phone`
// project runs it again at a phone's width.
import { pkgPrNewVersion } from "@iterate-com/shared/pkg-pr-new";
import { ensureVoiceAgent, upgradeVoice } from "@iterate-com/voice/install";
import { olderMainCommit } from "../test-support/published-builds.ts";
import { test } from "../test-support/test.ts";

// main's older builds predate voice run from the published config: `voice.ts` cannot re-export them
// parked: an older main build cannot run on this platform — revisit by 2026-10-12
test.skip("a project on an older voice build upgrades to main's newest from its page", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("voice");
  await using fixture = await helpers.createFixture("voice-upgrade", { app: baseURL });
  // set up with a key (only stored), then the older pin committed as the operator; the page reads
  // the pin and calls nothing, so the older build's code never runs here
  await ensureVoiceAgent(fixture.itx, "voice-spec-placeholder-key");
  const older = await olderMainCommit(["@iterate-com/voice"]);
  await upgradeVoice(fixture.itx, pkgPrNewVersion("@iterate-com/voice", older));
  const build = page.getByRole("region", { name: "Voice build" });

  await page.reload();
  await build.getByText(`${older.slice(0, 7)}. Main has a newer one`).waitFor();
  await build.getByRole("button", { name: "Upgrade to the newest" }).click();
  await build.getByText(`Upgraded from ${older.slice(0, 7)} to `).waitFor();
  await build.getByText("the newest on main").waitFor();

  // the project pins the new build, and still has its phone
  await page.reload();
  await build.getByText("the newest on main").waitFor();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();
});
