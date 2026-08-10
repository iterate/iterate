// The Media screen through the real phone-sized web build: real signup →
// drawer → /media, empty state, the sync toggle, capture via the picker's
// web fallback (an <input type=file>), the pending card, the processed row
// (real toMarkdown + vision calls on the dev deployment), search filtering,
// and the full-screen viewer chrome.
//
// LOCAL-ONLY for now (repo convention: positive opt-in flag, never
// process.env.CI — see specs/workspace-lens-board.spec.ts). Run with:
//
//   MOBILE_MEDIA_SPECS=1 pnpm spec --project=mobile -g "media"
//
// Misha unskips in CI after #2460's mobile-spec restoration lands.

import { resolve } from "node:path";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test.skip(
  process.env.MOBILE_MEDIA_SPECS !== "1",
  "local-only until #2460 lands — run with MOBILE_MEDIA_SPECS=1",
);

test("captures, searches, and views media through the phone-sized web build", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000); // two real vision-pipeline runs ride this spec
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-media-${Date.now().toString(36)}`;

  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  await popup.getByTestId("email-login-button").click({ timeout: 15_000 });
  await signUpWithEmailOtp(popup, {
    email: uniqueSignupEmail("mobile-media"),
    projectSlug,
    testInfo,
  });
  await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15_000 });
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });

  await page.getByText(projectSlug).click();
  await page.getByText("New chat").waitFor();
  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/media" }).click();

  // Empty state + the sync opt-in surface.
  await page.getByText("Nothing here yet").waitFor();
  await page.getByText("Auto-collect screenshots").waitFor();

  // Capture through the picker's web fallback: expo-image-picker on web
  // renders an <input type=file>. The ticket fixture reads "Train to
  // Florence / Seat 21A", so search assertions are content-real.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "+ Add" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(
    resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures/ticket.png"),
  );

  // Pending card first, then the processed row with the real description.
  await page.getByText("Analyzing…").waitFor({ timeout: 30_000 });
  await page
    .getByText(/Florence/)
    .first()
    .waitFor({ timeout: 120_000 });

  // Search: a transcript hit matches, garbage doesn't.
  await page.getByPlaceholder("Search descriptions and text…").fill("florence");
  await page
    .getByText(/Florence/)
    .first()
    .waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("zzz-no-such-thing");
  await page
    .getByText(/Florence/)
    .first()
    .waitFor({ state: "detached" });
  await page.getByPlaceholder("Search descriptions and text…").fill("");

  // Viewer: thumbnail opens full screen; tap toggles chrome; See more
  // expands the description panel.
  await page.getByLabel("View full screen").first().click();
  await page.getByLabel("Full screen media").click();
  await page.getByRole("button", { name: "See more" }).click();
  await page.getByText("See less").waitFor();
  await page.getByLabel("Close image").click();
  await page.getByText("Auto-collect screenshots").waitFor();
});

async function resolveOsBaseUrl(): Promise<string> {
  const fromEnv = process.env.APP_CONFIG_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
