import { expect, test } from "vitest";
import { channelForBranch, planPreview, renderBodySection } from "./publish-mobile-pr-preview.ts";

test("branch names become valid EAS channel names", () => {
  expect(channelForBranch("mobile-per-pr-preview-channels")).toBe("mobile-per-pr-preview-channels");
  expect(channelForBranch("fix/auth-url-error-display")).toBe("fix-auth-url-error-display");
  expect(channelForBranch("mmkal/26/07/03/voice-ios-app")).toBe("mmkal-26-07-03-voice-ios-app");
  expect(channelForBranch("Weird  Branch!!name")).toBe("weird-branch-name");
});

test("a runtime-matching PR renders with the OTA details open and install collapsed", () => {
  const plan = planPreview({
    scheme: "iterate",
    channel: "my-feature",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1",
  });
  expect(plan).toMatchObject({
    runtimeMatchesInstalled: true,
    deepLinkUrl: "iterate://preview-channel/my-feature",
  });

  const section = renderBodySection({
    plan,
    deepLinkQrUrl: "https://github.com/o/r/releases/download/gh-attach-assets/ota.png",
    installQrUrl: "https://github.com/o/r/releases/download/gh-attach-assets/install.png",
    headSha: "abcdef1234567890",
    publishedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  });
  expect(section).toContain("**JS-only** — the installed app can run it");
  expect(section).toContain("<details open><summary>OTA");
  expect(section).toContain("<details><summary>Full install");
  // Both QRs are tappable links.
  expect(section).toContain(
    '<a href="iterate://preview-channel/my-feature"><img src="https://github.com/o/r/releases/download/gh-attach-assets/ota.png"',
  );
  expect(section).toContain(
    '<a href="https://expo.dev/accounts/o/projects/p/builds/build-1"><img src="https://github.com/o/r/releases/download/gh-attach-assets/install.png"',
  );
});

test("a native-change PR flips the expanded details to the install QR", () => {
  const plan = planPreview({
    scheme: "iterate",
    channel: "add-native-module",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-2",
  });
  expect(plan).toMatchObject({ runtimeMatchesInstalled: false });

  const section = renderBodySection({
    plan,
    deepLinkQrUrl: "https://example.test/ota.png",
    installQrUrl: "https://example.test/install.png",
    headSha: "abcdef1234567890",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
  });
  expect(section).toContain("**native changes** — needs a fresh install");
  expect(section).toContain("<details><summary>OTA");
  expect(section).toContain("<details open><summary>Full install");
});

test("no finished preview build at all counts as a runtime mismatch", () => {
  const plan = planPreview({
    scheme: "iterate",
    channel: "first-ever",
    publishedRuntime: "aaaa000000000000000000000000000000000000",
    installedRuntime: undefined,
    installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-3",
  });
  expect(plan).toMatchObject({ runtimeMatchesInstalled: false });
});
