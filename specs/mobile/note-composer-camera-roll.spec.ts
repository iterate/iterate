// The note composer's camera-roll strip: the photo you just took is one tap
// away, above the text field, without opening the full-screen picker.
//
// A browser has no camera roll, so the web build reads its library from the
// boundary apps/mobile/src/lib/recent-photos.ts documents — filled here with
// real PNG fixtures before the app boots. Everything downstream of it is
// the shipping code path: the same strip component, the same tap-to-attach
// mutation, the same note write, and the same attachment rendered on /notes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("attaches a recent photo to a note straight from the composer strip", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-roll-${Date.now().toString(36)}`;

  await page.addInitScript(fixturePhotoLibrary());
  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  page.videoMode?.setStartTime();

  // The strip is already sitting above the text field on the project screen —
  // no navigation, no picker modal between opening the app and attaching the
  // photo you just took.
  await page.getByText(`→ /notes in ${projectSlug}`).waitFor();
  await page.getByLabel("Attach recent photo 1").click();

  // The tile flips to its attached state (and to the control that takes it
  // back off), and the photo joins the composer's attachment row.
  await page.getByLabel("Remove recent photo 1").waitFor();

  // Second thoughts on a second photo: attach, then tap the same tile again.
  await page.getByLabel("Attach recent photo 2").click();
  await page.getByLabel("Remove recent photo 2").click();
  await page.getByLabel("Attach recent photo 2").waitFor();

  // Past the last recent photo sits the way out to everything older — the
  // same full-screen picker the + button opens.
  await page.getByLabel("Choose from all photos").waitFor();

  await page.getByPlaceholder("Capture a note").fill("Ticket for the Florence train");
  await page.getByLabel("Save note").click();

  // The note lands on /notes carrying the photo the strip attached — the
  // whole point: the bytes really made the trip, under the filename the
  // library gave them.
  await page.getByText("view in /notes").click();
  await page
    .getByText(/Florence train/)
    .first()
    .waitFor();
  await page.getByLabel("View ticket.png").waitFor();
});

/** Three real PNGs as the browser's stand-in camera roll, newest first. */
function fixturePhotoLibrary(): string {
  const photos = ["ticket.png", "swim-email.png", "decoy-receipt.png"].map((filename) => ({
    assetId: `fixture-${filename}`,
    filename,
    dataUri: `data:image/png;base64,${readFileSync(
      resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures", filename),
    ).toString("base64")}`,
  }));
  return `globalThis.__ITERATE_WEB_PHOTO_LIBRARY__ = ${JSON.stringify(photos)};`;
}

async function signUpToProject(
  page: any,
  testInfo: any,
  osBaseUrl: string,
  projectSlug: string,
): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  // timeout: OIDC discovery + client registration have no loading UI for the spinner waiter
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  // timeout: the popup is outside the wrapped page, so no spinner waiter covers it
  await popup.getByTestId("email-login-button").click({ timeout: 15_000 });
  await signUpWithEmailOtp(popup, {
    email: uniqueSignupEmail("mobile-roll"),
    projectSlug,
    testInfo,
  });
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });
  await page.getByText("New chat").waitFor();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
