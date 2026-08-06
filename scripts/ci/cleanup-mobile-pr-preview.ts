// Deletes a closed PR's mobile preview leftovers: its EAS Update channel and
// branch (created by scripts/ci/publish-mobile-pr-preview.ts) and its QR
// assets on the gh-attach-assets release. Runs on pull_request closed
// (.depot/workflows/mobile-pr-preview-cleanup.yml). Every step tolerates
// absence — a PR whose preview never published must close clean.
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";
import { channelForBranch, easJson } from "./mobile-preview.ts";

/** What cleanup would touch, decided from the closed PR's shape. Pure so the
 * skip-vs-delete logic is testable without eas/GitHub. */
export const planCleanup = (input: { headRef: string | undefined; prNumber: number }) => {
  // The default channel must never be deletable via a branch named "preview".
  const channel = input.headRef ? channelForBranch(input.headRef) : undefined;
  return {
    channel: channel && channel !== "preview" ? channel : undefined,
    qrAssetPrefix: `mobile-pr-${input.prNumber}-`,
  };
};

async function cleanupMobilePrPreview() {
  const payload = readEventPayload();
  const pullRequest = payload.pull_request;
  if (!pullRequest?.number) {
    throw new Error("pull_request payload is required");
  }
  const plan = planCleanup({ headRef: pullRequest.head?.ref, prNumber: pullRequest.number });

  if (plan.channel) {
    for (const args of [
      ["channel:delete", plan.channel],
      ["branch:delete", plan.channel],
    ]) {
      try {
        easJson(args);
        console.log(`deleted ${args[0]?.split(":")[0]} ${plan.channel}`);
      } catch (error) {
        // Channel/branch may never have existed (preview never published) or
        // already be gone; eas-cli errors either way.
        console.log(`skipping ${args[0]}: ${String(error).split("\n")[0]}`);
      }
    }
  }

  const github = getOctokit();
  const repo = getRepo();
  const release = await github.rest.repos.getReleaseByTag({ ...repo, tag: "gh-attach-assets" });
  const stale = release.data.assets.filter((a) => a.name.startsWith(plan.qrAssetPrefix));
  for (const asset of stale) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    console.log(`deleted QR asset ${asset.name}`);
  }
  console.log(`cleanup complete for PR #${pullRequest.number}`);
}

if (isMainModule(import.meta.url)) {
  await cleanupMobilePrPreview();
}
