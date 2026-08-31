// Publishes the mobile app's JS bundle to the EAS Update `preview` channel;
// installed preview builds pull it on next launch. Then makes sure a native
// preview build exists for the update's runtime version: the fingerprint
// changes when native modules/config change, and old binaries silently
// ignore incompatible updates, so on mismatch this kicks off a fresh EAS
// build (--no-wait) whose install link supersedes the stale one. Finally
// writes the two-QR main section into the commit comment AND into the body
// of each merged PR this push belongs to — the merged PR is the natural
// on-ramp back onto main, not a commit comment nobody hunts down. A freshly
// triggered build renders "still running"; the refresh job
// (refresh-mobile-main-qr.ts) upgrades it when the build finishes.
// Runs on merge to main (.depot/workflows/mobile-eas-update.yml) with
// EXPO_TOKEN supplied by Doppler (`_shared`, inherited into os/prd).
// Section rendering/QR/eas plumbing: scripts/ci/mobile-preview.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import {
  easJson,
  ensureBuildForPr,
  latestInstalledRuntime,
  mobileDir,
  planPreview,
  prdBaseUrl,
  renderPreviewSection,
  run,
  syncMainPreviewSection,
  uploadQrAsset,
} from "./mobile-preview.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function publishMobileUpdate() {
  if (!process.env.EXPO_TOKEN) {
    throw new Error("EXPO_TOKEN is not set — eas-cli cannot authenticate");
  }

  run("node", ["scripts/write-build-info.mjs"], mobileDir);

  const message = run("git", ["log", "-1", "--format=%s"], repoRoot).trim().slice(0, 1024);
  const published = easJson([
    "update",
    "--channel",
    "preview",
    "--platform",
    "ios",
    "--message",
    message,
  ]);
  const updates = Array.isArray(published) ? published : [published];
  const runtimeVersion = updates[0]?.runtimeVersion;
  if (!runtimeVersion) {
    throw new Error(`unexpected eas update output: ${JSON.stringify(published)}`);
  }
  console.log(`published update ${updates[0].id} (runtime ${runtimeVersion}): ${message}`);

  // Was a phone able to run main's JS *before* this publish? Compares against
  // the newest finished build like the PR flow, so a fingerprint-changing
  // merge renders as "native changes" until its fresh build finishes.
  const installedRuntime = latestInstalledRuntime();
  const installBuild = ensureBuildForPr({ channel: "preview", runtime: runtimeVersion });

  const sha = process.env.GITHUB_SHA || run("git", ["rev-parse", "HEAD"], repoRoot).trim();
  const appConfig = JSON.parse(readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const { owner, slug, scheme } = appConfig.expo;
  const plan = planPreview({
    baseUrl: prdBaseUrl,
    scheme,
    channel: "preview",
    publishedRuntime: runtimeVersion,
    installedRuntime,
    installUrl: `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${installBuild.id}`,
    installReady: installBuild.finished,
    // Main's bundle stamps no expected backend (write-build-info.mjs ran
    // without the MOBILE_* env vars above): phones default to prd, and never
    // get a test sign-in offer (prd has no test OTP).
  });
  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(`mobile-main-${sha.slice(0, 9)}-ota-scheme.png`, plan.otaQrContent),
    uploadQrAsset(
      `mobile-main-${sha.slice(0, 9)}-install-${installBuild.id.slice(0, 8)}.png`,
      plan.installUrl,
    ),
  ]);
  const section = renderPreviewSection({
    variant: "main",
    plan,
    deepLinkQrUrl,
    installQrUrl,
    headSha: sha,
    installBuildSha: installBuild.gitCommitHash,
    publishedRuntime: runtimeVersion,
  });
  // syncMainPreviewSection writes the commit comment AND the merged PR
  // bodies' sections — getting onto latest main should never mean hunting
  // commit comments.
  await syncMainPreviewSection({ sha, section });

  // Hand the build-completion refresher what it needs: when the install
  // build was freshly triggered (--no-wait), the section above links a
  // "build still running" page, and the refresh job upgrades it once the
  // build finishes.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `install_ready=${installBuild.finished}\nbuild_id=${installBuild.id}\n`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  await publishMobileUpdate();
}
