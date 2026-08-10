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
import { deployedPreviewEnvs } from "../../envs.ts";
import { leasedPreviewSlotFromBody } from "../preview/preview.ts";
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
  type DeepLinkParams,
} from "./mobile-preview.ts";

/** markdownAnnotator label for the managed PR-body section. */
export const bodySectionLabel = "mobile-pr-preview";

/**
 * The recommended-backend + test-sign-in params for a PR's deep link, plus
 * the OS host that should serve its interstitial. Params: the leased preview
 * slot recorded in the PR body (when it names a real envs.ts preview config)
 * and a per-PR `pr<N>+test@nustom.com` identity. No slot — draft PRs don't
 * deploy previews — means no params at all: the app would default to prd,
 * where the test OTP is off and auto-login must not be offered.
 *
 * The interstitial HOST is the leased slot's own OS, not prd, whenever
 * params ride along: the interstitial must forward the query into the
 * `iterate://` bounce, and only the slot deployment is guaranteed to run the
 * same code revision as this publisher — prd runs whatever is on main, which
 * (before this feature merges, or after a future param change) may silently
 * drop the params. Bare links keep prd, which has served the channel-only
 * bounce forever.
 */
export function deepLinkForPr(input: { body: string; pullRequestNumber: number }): {
  params: DeepLinkParams;
  interstitialBaseUrl: string;
} {
  const slot = leasedPreviewSlotFromBody(input.body);
  const slotEnv = slot
    ? deployedPreviewEnvs.find((env) => env.dopplerConfig === slot.dopplerConfig)
    : undefined;
  if (!slotEnv) return { params: {}, interstitialBaseUrl: prdBaseUrl };
  return {
    params: {
      env: slotEnv.dopplerConfig,
      email: `pr${input.pullRequestNumber}+test@nustom.com`,
    },
    interstitialBaseUrl: slotEnv.baseUrl,
  };
}

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
  const { owner, slug, scheme } = appConfig.expo;
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

  const github = getOctokit();
  const repo = getRepo();
  // Fresh body, not the event payload's - it may have been edited since. Also
  // the source of the PR's leased preview slot (the Cloudflare preview deploy
  // maintains it there), which rides the deep link as the recommended backend.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pullRequest.number });
  const deepLink = deepLinkForPr({
    body: pr.body || "",
    pullRequestNumber: pullRequest.number,
  });

  const plan = planPreview({
    baseUrl: deepLink.interstitialBaseUrl,
    scheme,
    channel,
    publishedRuntime,
    installedRuntime,
    installUrl: `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${installBuild.id}`,
    deepLinkParams: deepLink.params,
  });

  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(
      // The env is part of the asset name: uploads dedupe by name, and a slot
      // leased after this sha's first publish must refresh the QR, not reuse
      // the env-less one.
      `mobile-pr-${pullRequest.number}-${headSha.slice(0, 9)}${deepLink.params.env ? `-${deepLink.params.env}` : ""}-ota-scheme.png`,
      plan.otaQrContent,
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
  const body = markdownAnnotator(pr.body || "", bodySectionLabel).update(section);
  await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, body });
  console.log(`updated mobile preview section in PR #${pullRequest.number} body`);
}

if (isMainModule(import.meta.url)) {
  await publishMobilePrPreview();
}
