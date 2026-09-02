// The chat composer's + sheet, through the phone-sized web build: + opens
// the attachment surface (recent-media carousel + the sendable-things rows),
// a carousel tap attaches a photo as a chip WITHOUT sending, tapping the
// tile again detaches it, and tapping a chip asks "Remove attachment?"
// before anything comes off.
//
// A browser has no camera roll, so the carousel reads the same injected
// library boundary the note composer uses
// (apps/mobile/src/lib/recent-photos.ts); the camera tile and location row
// are native-only surfaces (explicit Platform checks) and absent here.
//
// Chips: the corner ✕ removes (behind the confirm dialog); tapping the tile
// itself opens the SAME full-screen viewer sent photos use.
//
// Sending is OPTIMISTIC: the moment ↑ is tapped the message renders as a
// predicted bubble from phone-local data — no waiting for the upload or the
// server echo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "../test-support/test.ts";

test("+ opens the sheet; carousel attaches chips that need a confirm to remove", async ({
  page,
  helpers,
}) => {
  await page.addInitScript(fixturePhotoLibrary());
  await using fixture = await helpers.createMobileFixture("mobile-sheet");

  const agent = await fixture.createAgent();
  agent.responses.set(async () => "ok"); // the optimistic send opens a turn; answer it deterministically
  await page.goto(agent.mobileUrl);

  await page.getByLabel("Attach something").click();
  await page.getByText("All photos").waitFor();
  await page.getByText("Files").waitFor();

  await page.getByLabel("Attach recent photo").first().click();
  await page.getByLabel(/Attachment: ticket\.png/).waitFor();
  await page.getByLabel("Detach recent photo").waitFor();

  // Positive detach signal: BOTH tiles back in their attach state.
  await page.getByLabel("Detach recent photo").click();
  await page.getByLabel("Attach recent photo").nth(1).waitFor();

  // Tapping the chip ITSELF previews it full screen; closing returns to the
  // composer with the chip intact.
  await page.getByLabel("Attach recent photo").first().click();
  const chip = page.getByLabel(/Attachment: ticket\.png/);
  await chip.waitFor();
  await chip.click();
  const fullScreen = page.getByLabel("Full screen media");
  await fullScreen.waitFor();
  await fullScreen.click();
  await page.getByLabel("Close image").click();
  await chip.waitFor();

  // First tap: dismiss the confirm — the chip must survive.
  const removeBadge = page.getByLabel(/Remove ticket\.png/);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await removeBadge.click();
  await chip.waitFor();
  // Accept — now it goes.
  page.once("dialog", (dialog) => void dialog.accept());
  await removeBadge.click();
  await page.getByLabel("Attach recent photo").nth(1).waitFor();

  // Closing the sheet is the same + (now leaning as a ✕) — closed, its
  // label flips back to the attach affordance.
  await page.getByLabel("Close attachment options").click();
  await page.getByLabel("Attach something").waitFor();

  // Drawer semantics: tapping the conversation above the open sheet
  // dismisses it too.
  await page.getByLabel("Attach something").click();
  await page.getByText("All photos").waitFor();
  await page.getByLabel("Dismiss attachment options").click();
  await page.getByLabel("Attach something").waitFor();

  // Optimistic send: attach a photo, type, tap ↑ — the bubble (text AND
  // photo, rendered from local data) is visible immediately, while the
  // upload and echo happen behind it.
  await page.getByLabel("Attach something").click();
  await page.getByLabel("Attach recent photo").first().click();
  await page.getByLabel(/Attachment: ticket\.png/).waitFor();
  await page.getByPlaceholder("Message").fill("here's my train ticket");
  await page.getByLabel("Send", { exact: true }).click();
  await page.getByText("here's my train ticket").waitFor();
  await page.getByLabel("ticket.png", { exact: true }).waitFor();
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
