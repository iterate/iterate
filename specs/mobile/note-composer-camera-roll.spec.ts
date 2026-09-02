// The note composer's attachment surface: the SAME AttachmentSheet the chat
// composer uses (carousel of recent media, All photos / Files / Audio /
// Location) — only the destination differs: saving goes to /notes.
//
// A browser has no camera roll, so the web build reads its library from the
// boundary apps/mobile/src/lib/recent-photos.ts documents — filled here with
// real PNG fixtures before the app boots. Everything downstream of it is
// the shipping code path: the shared sheet component, the same
// tap-to-attach mutation, the same note write, and the same attachment
// rendered on /notes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "../test-support/test.ts";

test("attaches a recent photo to a note through the shared attachment sheet", async ({
  page,
  helpers,
}) => {
  await page.addInitScript(fixturePhotoLibrary());
  await using fixture = await helpers.createMobileFixture("mobile-roll");

  // The + on the note composer opens the same attachment sheet chat has.
  await page.getByText(`→ /notes in ${fixture.projectSlug}`).waitFor();
  await page.getByLabel("Attach something").click();
  await page.getByText("All photos").waitFor();
  await page.getByLabel("Attach recent photo").first().click();

  await page.getByLabel(/Attachment: ticket\.png/).waitFor();
  await page.getByLabel("Detach recent photo").waitFor();

  await page.getByLabel("Attach recent photo").first().click();
  await page.getByLabel("Detach recent photo").nth(1).click();
  await page.getByLabel("Detach recent photo").waitFor();

  await page.getByPlaceholder("Capture a note").fill("Ticket for the Florence train");
  await page.getByLabel("Save note").click();

  // The payoff: the bytes really made the trip, under the filename the
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
