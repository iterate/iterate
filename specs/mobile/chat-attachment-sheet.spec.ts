// The chat composer's + sheet, through the phone-sized web build: + opens
// the attachment surface (recent-media carousel + the sendable-things rows),
// a carousel tap attaches a photo as a chip WITHOUT sending, tapping the
// tile again detaches it, and tapping a chip asks "Remove attachment?"
// before anything comes off.
//
// A browser has no camera roll, so the carousel reads the same injected
// library boundary the note composer's strip uses
// (apps/mobile/src/lib/recent-photos.ts). Camera/mic/location surfaces are
// native-module-gated and simply absent here — exactly the old-client
// degradation the loaders guarantee (lib/native-modules.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("+ opens the sheet; carousel attaches chips that need a confirm to remove", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-sheet-${Date.now().toString(36)}`;

  await page.addInitScript(fixturePhotoLibrary());
  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  page.videoMode?.setStartTime();

  await page.getByText("New chat").click();
  await page.getByRole("heading", { name: /^mobile\// }).waitFor();

  // The + no longer jumps into the system picker — it opens the sheet, with
  // the recent-media carousel and the way into everything else.
  await page.getByLabel("Attach something").click();
  await page.getByText("All photos").waitFor();
  await page.getByText("Files").waitFor();

  // One tap on a recent photo attaches it as a chip above the input —
  // nothing sends, the tile flips to its detach state, and the chip carries
  // the photo's own filename.
  await page.getByLabel("Attach recent photo").first().click();
  await page.getByLabel(/Attachment: ticket\.png/).waitFor();
  await page.getByLabel("Detach recent photo").waitFor();

  // Tap the same tile again: attached → gone (the toggle semantics). The
  // positive signal is BOTH tiles back in their attach state.
  await page.getByLabel("Detach recent photo").click();
  await page.getByLabel("Attach recent photo").nth(1).waitFor();

  // Re-attach, then remove through the chip: the confirm dialog gates it.
  await page.getByLabel("Attach recent photo").first().click();
  const chip = page.getByLabel(/Attachment: ticket\.png/);
  await chip.waitFor();
  // First tap: dismiss the dialog — the chip must survive.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await chip.click();
  await chip.waitFor();
  // Second tap: accept — now it goes, and the carousel tile flips back to
  // its attach state (the positive signal that the attachment came off).
  page.once("dialog", (dialog) => void dialog.accept());
  await chip.click();
  await page.getByLabel("Attach recent photo").nth(1).waitFor();

  // Closing the sheet is the same + (now leaning as a ✕) — closed, its
  // label flips back to the attach affordance.
  await page.getByLabel("Close attachment options").click();
  await page.getByLabel("Attach something").waitFor();
});

/** Real PNGs as the browser's stand-in camera roll, newest first. */
function fixturePhotoLibrary(): string {
  const photos = ["ticket.png", "swim-email.png"].map((filename) => ({
    assetId: `fixture-${filename}`,
    filename,
    dataUri: `data:image/png;base64,${readFileSync(
      resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures", filename),
    ).toString("base64")}`,
  }));
  return `globalThis.__ITERATE_WEB_PHOTO_LIBRARY__ = ${JSON.stringify(photos)};`;
}

async function signUpToProject(
  page: test.Page,
  testInfo: test.TestInfo,
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
    email: uniqueSignupEmail("mobile-sheet"),
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
