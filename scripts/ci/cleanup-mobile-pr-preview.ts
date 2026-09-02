// Deletes a closed PR's mobile preview leftovers: its EAS Update channel and
// branch (created by scripts/ci/publish-mobile-pr-preview.ts) and its QR
// assets on the gh-attach-assets release — then rewrites the PR body's QR
// section, which would otherwise render broken images pointing at a channel
// that no longer exists. A merged PR's placeholder says main's QRs are on
// the way (the merge-push publisher writes them — publish-mobile-update.ts);
// an unmerged close gets a one-line note. Runs on pull_request closed
// (.depot/workflows/mobile-pr-preview-cleanup.yml). Every step tolerates
// absence — a PR whose preview never published must close clean.
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";
import {
  bodySectionLabel,
  channelForBranch,
  deleteChannelStatus,
  easJson,
  isMainFlavoredSection,
} from "./mobile-preview.ts";

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

/** The section a closed PR is left with. Merged PRs promise main's QRs —
 * the merge-push publisher (or its build-completion refresher) delivers
 * them, usually within minutes. Pure for the test. */
export const closedSectionContents = (input: { merged: boolean }) =>
  input.merged
    ? [
        "## 📱 Mobile preview",
        "",
        "Merged — this PR's preview channel is deleted. Main's QR codes land here once the",
        "merge's publish (and native build, when the runtime changed) completes.",
      ].join("\n")
    : [
        "## 📱 Mobile preview",
        "",
        "<sub>Closed without merging — the preview channel and its QR codes are deleted.</sub>",
      ].join("\n");

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
    // The install interstitial for a deleted channel must fall back to its
    // honest "no publish snapshot" page rather than offer a stale build.
    await deleteChannelStatus(plan.channel);
  }

  const github = getOctokit();
  const repo = getRepo();
  const release = await github.rest.repos.getReleaseByTag({ ...repo, tag: "gh-attach-assets" });
  const stale = release.data.assets.filter((a) => a.name.startsWith(plan.qrAssetPrefix));
  for (const asset of stale) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    console.log(`deleted QR asset ${asset.name}`);
  }
  // The body's QR images were just deleted above — swap the section for an
  // honest placeholder. Fresh body (it may have been edited since the
  // event), and never clobber a section the merge-push publisher already
  // upgraded to main's — the closed event and the merge push race.
  const { data: fresh } = await github.rest.pulls.get({
    ...repo,
    pull_number: pullRequest.number,
  });
  const annotator = markdownAnnotator(fresh.body || "", bodySectionLabel);
  if (annotator.current !== null && !isMainFlavoredSection(annotator.current)) {
    await github.rest.pulls.update({
      ...repo,
      pull_number: pullRequest.number,
      body: annotator.update(closedSectionContents({ merged: Boolean(pullRequest.merged) })),
    });
    console.log(`replaced the preview section in PR #${pullRequest.number}`);
  }

  console.log(`cleanup complete for PR #${pullRequest.number}`);
}

if (isMainModule(import.meta.url)) {
  await cleanupMobilePrPreview();
}
