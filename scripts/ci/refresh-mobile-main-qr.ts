// Upgrades the "build still running" install link that publish-mobile-update
// writes when a fingerprint-changing merge triggers a fresh main build
// (--no-wait): polls that build to completion, then re-renders the main
// preview section — commit comment and merged PR bodies alike, via the same
// syncMainPreviewSection door — with the now-installable link. Runs as the
// non-serialized second job of .depot/workflows/mobile-eas-update.yml, so a
// twenty-minute build never queues later merge publishes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import {
  easJson,
  mobileDir,
  planPreview,
  prdBaseUrl,
  renderPreviewSection,
  syncMainPreviewSection,
  uploadQrAsset,
} from "./mobile-preview.ts";

const POLL_SECONDS = 60;
const GIVE_UP_MINUTES = 40;

async function refreshMobileMainQr() {
  const buildId = process.env.BUILD_ID;
  const sha = process.env.GITHUB_SHA;
  if (!buildId || !sha) throw new Error("BUILD_ID and GITHUB_SHA are required");
  if (!process.env.EXPO_TOKEN) {
    throw new Error("EXPO_TOKEN is not set — eas-cli cannot authenticate");
  }

  const deadline = Date.now() + GIVE_UP_MINUTES * 60_000;
  let build: any;
  for (;;) {
    build = easJson(["build:view", buildId]);
    console.log(`build ${buildId}: ${build.status}`);
    if (build.status === "FINISHED") break;
    if (!["NEW", "IN_QUEUE", "IN_PROGRESS"].includes(build.status)) {
      // A failed/canceled build: the pending link stays (its page shows what
      // happened), and the next merge's publish supersedes it. Say so loudly
      // rather than pretending this run covered it.
      console.log(`giving up: build ended ${build.status}; the pending link stays as published`);
      return;
    }
    if (Date.now() > deadline) {
      console.log(`giving up after ${GIVE_UP_MINUTES}m; the pending link stays as published`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }

  const appConfig = JSON.parse(readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const { owner, slug, scheme } = appConfig.expo;
  const plan = planPreview({
    baseUrl: prdBaseUrl,
    scheme,
    channel: "preview",
    publishedRuntime: build.runtimeVersion,
    // The build we just watched finish IS the installable one.
    installedRuntime: build.runtimeVersion,
    installUrl: `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${build.id}`,
    installReady: true,
  });
  // Same sha-derived asset names the publisher used — uploads are idempotent.
  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(`mobile-main-${sha.slice(0, 9)}-ota-scheme.png`, plan.otaQrContent),
    uploadQrAsset(
      `mobile-main-${sha.slice(0, 9)}-install-${build.id.slice(0, 8)}.png`,
      plan.installUrl,
    ),
  ]);
  const section = renderPreviewSection({
    variant: "main",
    plan,
    deepLinkQrUrl,
    installQrUrl,
    headSha: sha,
    installBuildSha: build.gitCommitHash,
    publishedRuntime: build.runtimeVersion,
  });
  await syncMainPreviewSection({ sha, section });
}

if (isMainModule(import.meta.url)) {
  await refreshMobileMainQr();
}
