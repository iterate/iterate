// Per-PR mobile previews: publishes the PR's JS bundle to an EAS Update
// channel named after its branch, then maintains a managed PR-body section
// with two QR codes — an OTA link into the installed app and a full-install
// link — expanding whichever the runtime-fingerprint heuristic says Misha
// needs. Runs on PRs touching apps/mobile
// (.depot/workflows/mobile-pr-preview.yml); EXPO_TOKEN via Doppler like the
// merge-to-main publish (scripts/ci/publish-mobile-update.ts).
// Section rendering/QR/eas plumbing: scripts/ci/mobile-preview.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";
import {
  channelForBranch,
  easJson,
  ensureBuildForRuntime,
  latestInstalledRuntime,
  mobileDir,
  planPreview,
  prdBaseUrl,
  renderPreviewSection,
  run,
  uploadQrAsset,
} from "./mobile-preview.ts";

/** markdownAnnotator label for the managed PR-body section. */
export const bodySectionLabel = "mobile-pr-preview";

async function publishMobilePrPreview() {
  const payload = readEventPayload();
  const pullRequest = payload.pull_request;
  if (!pullRequest?.head?.ref || !pullRequest.head.sha) {
    throw new Error("pull_request payload with head ref/sha is required");
  }
  if (!process.env.EXPO_TOKEN) {
    throw new Error("EXPO_TOKEN is not set — eas-cli cannot authenticate");
  }

  const appConfig = JSON.parse(readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const { owner, slug } = appConfig.expo;
  const channel = channelForBranch(pullRequest.head.ref);
  const headSha = pullRequest.head.sha;

  const repoForUrl = getRepo();
  process.env.MOBILE_BUILD_GITHUB_URL =
    pullRequest.html_url ||
    `https://github.com/${repoForUrl.owner}/${repoForUrl.repo}/pull/${pullRequest.number}`;
  run("node", ["scripts/write-build-info.mjs"], mobileDir);
  const message = `PR #${pullRequest.number}: ${(pullRequest.title || "").slice(0, 900)}`;
  // --clear-cache: CI reuses sandboxes across branches and Metro's cache
  // bakes in absolute paths (see tasks/complete/2026-08-04-mobile-build-info-commit-message.md).
  const published = easJson([
    "update",
    "--channel",
    channel,
    "--platform",
    "ios",
    "--clear-cache",
    "--message",
    message,
  ]);
  const updates: any[] = Array.isArray(published) ? published : [published];
  const publishedRuntime = updates[0]?.runtimeVersion;
  if (!publishedRuntime) {
    throw new Error(`unexpected eas update output: ${JSON.stringify(published)}`);
  }
  console.log(
    `published update ${updates[0].id} to channel ${channel} (runtime ${publishedRuntime})`,
  );

  const installedRuntime = latestInstalledRuntime();
  const installBuild = ensureBuildForRuntime(publishedRuntime);

  const plan = planPreview({
    baseUrl: prdBaseUrl,
    channel,
    publishedRuntime,
    installedRuntime,
    installUrl: `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${installBuild.id}`,
  });

  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(
      `mobile-pr-${pullRequest.number}-${headSha.slice(0, 9)}-ota.png`,
      plan.deepLinkUrl,
    ),
    uploadQrAsset(
      `mobile-pr-${pullRequest.number}-${headSha.slice(0, 9)}-install-${installBuild.id.slice(0, 8)}.png`,
      plan.installUrl,
    ),
  ]);

  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl,
    installQrUrl,
    headSha,
    installBuildSha: installBuild.gitCommitHash,
    publishedRuntime,
  });
  const github = getOctokit();
  const repo = getRepo();
  // Fresh body, not the event payload's - it may have been edited since.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pullRequest.number });
  const body = markdownAnnotator(pr.body || "", bodySectionLabel).update(section);
  await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, body });
  console.log(`updated mobile preview section in PR #${pullRequest.number} body`);
}

if (isMainModule(import.meta.url)) {
  await publishMobilePrPreview();
}
