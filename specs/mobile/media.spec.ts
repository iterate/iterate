// The Media screen through the real phone-sized web build, in two lanes:
//
// 1. Deterministic (CI-able): real signup, then a captured event SEEDED over
//    the admin API — no AI calls — proving list rendering, search filtering,
//    and the full-screen viewer chrome.
// 2. The live capture pipeline (opt-in): file-input capture through the real
//    toMarkdown + vision calls. AI-dependent, so never deterministic — a
//    permanent opt-in and an eval candidate rather than a CI test.
//
//   MOBILE_MEDIA_SPECS=1 pnpm spec --project=mobile -g "media"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "../test-support/test.ts";

test("renders, searches, and views seeded media", async ({ page, helpers }) => {
  await using fixture = await helpers.createMobileFixture("mobile-media");
  const { itx } = fixture;

  // Seed one captured item the way the pipeline would have written it — no
  // AI involved, so assertions are exact. (Vocabulary inlined from
  // apps/mobile/src/lib/media.ts, which Playwright's transformer can't load.)
  const stableKey = "spec-seeded-ticket";
  const path = `/media/${stableKey}-ticket.png`;
  const png = readFileSync(
    resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures/ticket.png"),
  );
  await itx.files.get(path).put({ data: new Uint8Array(png), contentType: "image/png" });
  await itx.streams.get("/media").append({
    type: "events.iterate.com/media/captured",
    idempotencyKey: `media-captured-${stableKey}`,
    payload: {
      stableKey,
      title: "Trenitalia ticket to Florence",
      path,
      filename: "ticket.png",
      contentType: "image/png",
      width: 280,
      height: 110,
      source: "library-sync",
      capturedAt: "2026-08-10T09:00:00.000Z",
      isScreenshot: true,
      markdown: "A train ticket to Florence.",
      transcript: "Train to Florence Seat 21A",
      tags: ["screenshot", "logistics"],
      processedBy: "spec-fixture",
    },
  });

  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/media" }).click();

  // The seeded row, its tags, and search over description + transcript.
  await page.getByText("A train ticket to Florence.").waitFor();
  // "logistics" renders as both a filter chip and the row tag.
  await page.getByText("logistics", { exact: true }).nth(1).waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("seat 21a");
  await page.getByText("A train ticket to Florence.").waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("zzz-no-match");
  await page.getByText("No results").waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("");

  // Viewer: thumbnail → full screen; tap toggles chrome; See more expands.
  await page.getByLabel("View full screen").first().click();
  await page.getByLabel("Full screen media").click();
  await page.getByRole("button", { name: "See more" }).click();
  await page.getByText("See less").waitFor();
  await page.getByLabel("Close image").click();

  // The toolbar's ⋯ button opens the options dialog — nothing syncs on tap.
  await page.getByLabel("Media options").click();
  await page.getByText("Nothing happens until you confirm here.").waitFor();
  await page.getByText("1 week", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Turn on" }).waitFor();

  // Delete-all lives behind its own inline confirm, then the wiped
  // tombstone clears the list live.
  await page.getByText("Delete all media from this project…").click();
  await page.getByText(/cannot be undone/).waitFor();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await page.getByText("Nothing here yet").waitFor();
});

test("captures through the live vision pipeline", async ({ page, helpers }) => {
  test.skip(
    process.env.MOBILE_MEDIA_SPECS !== "1",
    "parked: AI-dependent (real toMarkdown + vision calls), so never CI-deterministic — likely becomes an eval; run with MOBILE_MEDIA_SPECS=1 — revisit by 2026-09-21",
  );
  await using _fixture = await helpers.createMobileFixture("mobile-media-ai");
  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/media" }).click();
  await page.getByText("Nothing here yet").waitFor();

  // Capture through the picker's web fallback (an <input type=file>). The
  // upload is a fast durable append; the row then shows an Analyzing… badge
  // whose spinner keeps the spinner waiter extending the wait while the
  // SERVER-side vision pipeline runs — no explicit timeouts.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "+ Add" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(
    resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures/ticket.png"),
  );
  await page.getByText("Analyzing…").waitFor();
  await page
    .getByText(/Florence/)
    .first()
    .waitFor();
});
