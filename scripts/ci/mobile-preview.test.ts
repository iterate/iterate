import { expect, test } from "vitest";
import { channelForBranch, planPreview, renderPreviewSection } from "./mobile-preview.ts";

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
  });
  expect(plan).toMatchObject({ runtimeMatchesInstalled: false });
});
