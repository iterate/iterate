import { expect, test } from "vitest";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import {
  channelForBranch,
  installInterstitialUrl,
  planPreview,
  renderPreviewSection,
} from "./mobile-preview.ts";
import { bundleStampForPr } from "./publish-mobile-pr-preview.ts";

test("branch names become valid EAS channel names", () => {
  expect(channelForBranch("mobile-per-pr-preview-channels")).toBe("mobile-per-pr-preview-channels");
  expect(channelForBranch("fix/auth-url-error-display")).toBe("fix-auth-url-error-display");
  expect(channelForBranch("mmkal/26/07/03/voice-ios-app")).toBe("mmkal-26-07-03-voice-ios-app");
  expect(channelForBranch("Weird  Branch!!name")).toBe("weird-branch-name");
});

test("links go through the https interstitial, never a raw iterate:// href", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "my-feature",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1",
    installReady: true,
  });
  expect(plan).toMatchObject({
    runtimeMatchesInstalled: true,
    // Tap path: https interstitial (GitHub strips custom-scheme hrefs).
    deepLinkUrl: "https://os.iterate.com/m/preview-channel/my-feature",
    // Scan path: the camera opens the app scheme directly, no interstitial hop.
    otaQrContent: "iterate://preview-channel/my-feature",
  });

  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://github.com/o/r/releases/download/gh-attach-assets/ota.png",
    installQrUrl: "https://github.com/o/r/releases/download/gh-attach-assets/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "0123456789abcdef",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  });
  // GitHub strips custom-scheme hrefs at render time - they must never appear.
  expect(section).not.toContain("iterate://");
  // The tap path is a bold markdown link; the scan path is the (half-size) QR.
  expect(section).toContain(
    "**[Switch this phone to the PR channel](https://os.iterate.com/m/preview-channel/my-feature)**",
  );
  expect(section).toContain('width="90"');
  expect(section).not.toContain('width="180"');
});

test("a runtime-matching PR renders with the OTA details open and install collapsed", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "my-feature",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1",
    installReady: true,
  });
  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "0123456789abcdef",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  });
  expect(section).toContain("**JS-only** — the installed app can run it");
  expect(section).toContain("<details open><summary>OTA");
  expect(section).toContain("<details><summary>Full install");
  // Each summary carries its own sha - the install build is often older than the head.
  expect(section).toContain("channel (`abcdef1`)");
  expect(section).toContain("differs (`0123456`)");
});

test("a native-change PR flips the expanded details to the install QR", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "add-native-module",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-2",
    installReady: true,
  });
  expect(plan).toMatchObject({ runtimeMatchesInstalled: false });

  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "abcdef1234567890",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
  });
  expect(section).toContain("**native changes** — needs a fresh install");
  expect(section).toContain("<details><summary>OTA");
  expect(section).toContain("<details open><summary>Full install");
});

test("the main variant reads as a switch-back, not a PR switch", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "preview",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1",
    installReady: true,
  });
  const section = renderPreviewSection({
    variant: "main",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "0123456789abcdef",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  });
  expect(section).toContain("## 📱 Mobile preview — main");
  expect(section).toContain("default-channel phones pull this automatically (`abcdef1`)");
  expect(section).toContain(
    "**[Switch this phone back to the default channel now](https://os.iterate.com/m/preview-channel/preview)**",
  );
});

test("no finished preview build at all counts as a runtime mismatch", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "first-ever",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: undefined,
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-3",
    installReady: true,
  });
  expect(plan).toMatchObject({ runtimeMatchesInstalled: false });
});

test("bundleStampForPr reads the leased slot out of the PR body's hidden preview state", () => {
  const state = { environmentConfigLease: { slug: "preview-12", dopplerConfig: "preview_12" } };
  const body = [
    "Some PR description.",
    markdownAnnotator("", "CLOUDFLARE_PREVIEW_STATE").update(
      `<!--\n${JSON.stringify(state, null, 2)}\n-->`,
    ),
  ].join("\n\n");
  expect(bundleStampForPr({ body, pullRequestNumber: 2422 })).toEqual({
    MOBILE_EXPECTED_BACKEND_ENV: "preview_12",
    MOBILE_TEST_LOGIN_EMAIL: "pr2422+test@nustom.com",
  });
});

test("bundleStampForPr stamps nothing without a leased preview slot", () => {
  // No preview state at all (e.g. a PR that never deployed): the bundle
  // must not recommend a backend — phones default to prd, where the test
  // OTP is off and auto-login must not be offered.
  expect(bundleStampForPr({ body: "just a description", pullRequestNumber: 7 })).toEqual({
    MOBILE_EXPECTED_BACKEND_ENV: "",
    MOBILE_TEST_LOGIN_EMAIL: "",
  });
  // A slot that is not a known preview_N envs.ts config must not be offered.
  const bogus = { environmentConfigLease: { slug: "prd", dopplerConfig: "prd" } };
  const body = markdownAnnotator("", "CLOUDFLARE_PREVIEW_STATE").update(
    `<!--\n${JSON.stringify(bogus)}\n-->`,
  );
  expect(bundleStampForPr({ body, pullRequestNumber: 7 })).toEqual({
    MOBILE_EXPECTED_BACKEND_ENV: "",
    MOBILE_TEST_LOGIN_EMAIL: "",
  });
});

test("a PR's install QR goes to the channel-stable interstitial and explains the channel hop", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "add-native-module",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: installInterstitialUrl("https://os.iterate.com", "add-native-module"),
    installReady: true,
  });
  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "abcdef1234567890",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
  });
  // Builds are shared across channels (one per runtime fingerprint); the
  // install link resolves the right build at scan time, and the page's
  // "Open in app" tap does the channel hop after the install.
  expect(section).toContain("https://os.iterate.com/m/install/add-native-module");
  expect(section).toContain(
    "After installing, tap <b>Open in app</b> on that page to land on <code>add-native-module</code>.",
  );
  expect(section).not.toContain("expo.dev");
});

test("a build that hasn't finished says so instead of offering a dead install link", () => {
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "brand-new-branch",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: undefined,
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-9",
    installReady: false,
  });
  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: undefined,
    publishedRuntime: "aaaa000000000000000000000000000000000000",
  });
  expect(section).toContain("Build still running — the install page fills in when it finishes");
});

test("the PR footer routes back to main via the explicit switch, not reset-to-default", () => {
  // A per-PR binary's default channel IS its PR — and cleanup deletes that
  // channel on merge. "Reset to default channel" can no longer promise main.
  const plan = planPreview({
    baseUrl: "https://os.iterate.com",
    scheme: "iterate",
    channel: "my-feature",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1",
    installReady: true,
  });
  const section = renderPreviewSection({
    variant: "pr",
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    installBuildSha: "0123456789abcdef",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  });
  expect(section).toContain("Build info → Switch to main");
  expect(section).not.toContain("Reset to default channel");
});
