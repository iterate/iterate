// Upgrades the "build still running" install link that publish-mobile-update
// writes when a fingerprint-changing merge triggers a fresh main build
// (--no-wait): polls that build to completion, then re-renders the main
// preview section — commit comment and merged PR bodies alike, via the same
// syncMainPreviewSection call the publisher used — with the now-installable
// link. Runs as the
// non-serialized second job of .depot/workflows/mobile-eas-update.yml, so a
// twenty-minute build never queues later merge publishes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import {
  easJson,
  fetchChannelStatus,
  installInterstitialUrl,
  mobileDir,
  planPreview,
  mobileWebsiteBaseUrl,
  pushChannelStatus,
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

  // Flip the channel snapshot to installable — unless a newer merge already
  // superseded this build's snapshot, which must not be regressed.
  const status = await fetchChannelStatus("preview");
  if (status !== null && status.buildId === build.id) {
    await pushChannelStatus({
      ...status,
      buildFinished: true,
      // The publish wrote no ipaUrl (the build hadn't finished); it has one now.
      ipaUrl: build.artifacts?.applicationArchiveUrl || status.ipaUrl,
    });
  } else {
    console.log(
      `snapshot now points at ${status?.buildId || "nothing"} (not ${build.id}) — leaving it`,
    );
  }

  const appConfig = JSON.parse(readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const { scheme } = appConfig.expo;
  const plan = planPreview({
    baseUrl: mobileWebsiteBaseUrl,
    scheme,
    channel: "preview",
    publishedRuntime: build.runtimeVersion,
    // Deliberately NOT build.runtimeVersion: this job only runs because the
    // merge changed the runtime, so phones are still on the old binary — the
    // section must keep saying "native changes — needs a fresh install" with
    // the install QR expanded, now that its link is actually installable.
    installedRuntime: undefined,
    installUrl: installInterstitialUrl(mobileWebsiteBaseUrl, "preview"),
    installReady: true,
  });
  // Same channel-stable asset names the publisher used — uploads are
  // skip-if-exists and the contents are identical.
  const [deepLinkQrUrl, installQrUrl] = await Promise.all([
    uploadQrAsset(`mobile-main-ota-scheme.png`, plan.otaQrContent),
    uploadQrAsset(`mobile-main-install-site.png`, plan.installUrl),
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
