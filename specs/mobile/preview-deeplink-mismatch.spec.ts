// The preview-channel screen's state-mismatch card: a phone pointed at prd,
// signed out, scanning a QR that recommends preview_3 + a test identity must
// SEE what differs (backend + identity) and get the one-tap fix. Web-lane
// only exercises rendering and the planner wiring — the tap itself opens a
// real OAuth flow (covered on-device / by preview-deeplink-hints.spec.ts's
// deployed lane) and real OTA freshness needs a device (Updates.isEnabled is
// false in web bundles; the screen must say so instead).

import { test } from "../test-support/test.ts";

const HINT_EMAIL = "pr2462+test@nustom.com";

test("a mismatched phone sees the differences and a one-tap sign-in fix", async ({ page }) => {
  await page.addInitScript(() => {
    // The web SecureStore shim (apps/mobile/src/lib/secure-store.ts) reads
    // localStorage under this prefix; seed "phone pointed at prd, signed out".
    localStorage.setItem("iterate.secure-store.iterate.server", "https://os.iterate.com");
    localStorage.setItem("preview-channel-override", "spec-chan");
  });
  await page.goto("/preview-channel/spec-chan?env=preview_3&email=pr2462+test%40nustom.com");
  await page.getByText("You're already on this channel").waitFor();
  // Web dev bundles can't OTA — the freshness slot must explain, not sit silent.
  await page.getByText("OTA updates don't run in dev bundles", { exact: false }).waitFor();
  // The mismatch card names both differences…
  await page.getByText("This QR expects a different setup").waitFor();
  await page.getByText("os.iterate.com → preview 3").waitFor();
  await page.getByText(`not signed in → ${HINT_EMAIL}`).waitFor();
  // …and the planner picks the single action that fixes both.
  await page.getByRole("button", { name: `Sign in on preview 3 as ${HINT_EMAIL}` }).waitFor();
});

test("a phone already matching the recommendation is told so", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("iterate.secure-store.iterate.server", "https://os.iterate-preview-3.com");
    localStorage.setItem("preview-channel-override", "spec-chan");
  });
  // No email hint: backend matching is the whole recommendation.
  await page.goto("/preview-channel/spec-chan?env=preview_3");
  await page.getByText("Backend and sign-in match this QR's recommendation.").waitFor();
});
