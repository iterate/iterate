// The preview-channel screen's state-mismatch card: a phone pointed at prd,
// signed out, running a bundle stamped for preview_3 + a test identity must
// SEE what differs (backend + identity) and get the one-tap fix. The stamp
// comes from the dev-only build-info override (the web dev bundle is
// unstamped — apps/mobile/src/lib/build-info.ts). Web-lane only exercises
// rendering and the planner wiring — the tap itself opens a real OAuth flow
// (covered by expected-backend-signin.spec.ts's deployed lane) and real OTA
// freshness needs a device (Updates.isEnabled is false in web bundles; the
// screen must say so instead).

import { test } from "../test-support/test.ts";

const HINT_EMAIL = "pr2462+test@nustom.com";

test("a mismatched phone sees the differences and a one-tap sign-in fix", async ({ page }) => {
  await page.addInitScript(() => {
    // The web SecureStore shim (apps/mobile/src/lib/secure-store.ts) reads
    // localStorage under this prefix; seed "phone pointed at prd, signed out".
    localStorage.setItem("iterate.secure-store.iterate.server", "https://os.iterate.com");
    localStorage.setItem("preview-channel-override", "spec-chan");
    localStorage.setItem(
      "build-info-override",
      JSON.stringify({ expectedBackendEnv: "preview_3", testLoginEmail: "pr2462+test@nustom.com" }),
    );
  });
  await page.goto("/preview-channel/spec-chan");
  await page.getByText("You're already on this channel").waitFor();
  // Web dev bundles can't OTA — the freshness slot must explain, not sit silent.
  await page.getByText("OTA updates don't run in dev bundles", { exact: false }).waitFor();
  // The mismatch card names both differences…
  await page.getByText("This bundle expects a different setup").waitFor();
  await page.getByText("os.iterate.com → preview 3").waitFor();
  await page.getByText(`not signed in → ${HINT_EMAIL}`).waitFor();
  // …and the planner picks the single action that fixes both.
  await page.getByRole("button", { name: `Sign in on preview 3 as ${HINT_EMAIL}` }).waitFor();
});

test("a phone already matching the expectation is told so", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("iterate.secure-store.iterate.server", "https://os.iterate-preview-3.com");
    localStorage.setItem("preview-channel-override", "spec-chan");
    // No test identity: backend matching is the whole expectation.
    localStorage.setItem(
      "build-info-override",
      JSON.stringify({ expectedBackendEnv: "preview_3" }),
    );
  });
  await page.goto("/preview-channel/spec-chan");
  await page.getByText("Backend and sign-in match what this bundle expects.").waitFor();
});
