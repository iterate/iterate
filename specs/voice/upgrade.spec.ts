// Voice's upgrade (apps/voice projects.$slug.tsx, packages/ui app-build.tsx): a project on an older
// voice build main published sees it under Call and upgrades to main's newest. The `voice-phone`
// project runs it again at a phone's width.
import { pkgPrNewVersion } from "@iterate-com/shared/pkg-pr-new";
import { ensureVoiceAgent } from "@iterate-com/voice/install";
import { olderMainCommit } from "../test-support/published-builds.ts";
import { test } from "../test-support/test.ts";

test("a project on an older voice build upgrades to main's newest from its page", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("voice");
  await using fixture = await helpers.createFixture("voice-upgrade", { app: baseURL });
  // Install voice on the page pins the newest builds, so the older ones are seeded as the operator.
  // The key is only stored: health answers without calling OpenAI.
  const older = await olderMainCommit(["@iterate-com/agents", "@iterate-com/voice"]);
  await ensureVoiceAgent(
    fixture.itx,
    {
      agents: pkgPrNewVersion("@iterate-com/agents", older),
      voice: pkgPrNewVersion("@iterate-com/voice", older),
    },
    "voice-spec-placeholder-key",
  );
  const build = page.getByRole("region", { name: "Voice build" });

  await page.reload();
  await build.getByText(`${older.slice(0, 7)}. Main has a newer one`).waitFor();
  await build.getByRole("button", { name: "Upgrade to the newest" }).click();
  await build.getByText(`Upgraded from ${older.slice(0, 7)} to `).waitFor();
  await build.getByText("the newest on main").waitFor();

  // the project runs the new build, and still has its phone
  await page.reload();
  await build.getByText("the newest on main").waitFor();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();
});
