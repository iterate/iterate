// The notes feature through the real phone-sized web build: the GLOBAL
// capture composer (visible the moment the project opens — the feature's
// whole premise), a real capture appended to /notes with no AI in the path,
// the ✕→📝-pill collapse, the /notes screen's list, search, inline edit and
// delete confirm, and the 💬 hand-off into a conversation about a note. The title/tags analysis obligation runs server-side and is
// covered by apps/mobile/e2e/notes.e2e.test.ts (AI-dependent); assertions
// here stick to the note's own text, which is stable whether or not the
// derived title has landed yet.

import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("captures a note from the global composer and manages it on /notes", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-notes");

  // The composer is already there on the chat-list screen — no navigation
  // between "I opened the app" and "I captured the thought".
  await page.getByText(`→ /notes in ${fixture.projectSlug}`).waitFor();
  await page.getByPlaceholder("Capture a note").fill("Standing desk height: 76cm felt right");
  await page.getByLabel("Save note").click();

  await page.getByLabel("Collapse note composer").click();
  await page.getByPlaceholder("Capture a note").waitFor({ state: "hidden" });
  await page.getByLabel("Capture a note").click();
  await page.getByPlaceholder("Capture a note").waitFor();

  // First-line title until the analysis settlement overlays it — either way
  // the note's own text is on screen.
  await page.getByText("view in /notes").click();
  await page.getByPlaceholder("Search notes…").waitFor();
  await page
    .getByText(/76cm felt right/)
    .first()
    .waitFor();

  await page.getByPlaceholder("Search notes…").fill("standing desk");
  await page
    .getByText(/76cm felt right/)
    .first()
    .waitFor();
  await page.getByPlaceholder("Search notes…").fill("zzz-no-match");
  await page.getByText("No results").waitFor();
  await page.getByPlaceholder("Search notes…").fill("");

  await page
    .getByText(/76cm felt right/)
    .first()
    .click();
  await page.getByRole("button", { name: "✏️ Edit" }).click();
  await page.getByLabel("Edit note text").fill("Standing desk height: 76cm — confirmed at home");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText(/confirmed at home/)
    .first()
    .waitFor();

  // 💬 pre-types a pointer to the note; the question under it is the human's
  // to write, so nothing is sent on the way in.
  await page.getByLabel("Chat about this note").click();
  // The Opening chat spinner keeps the locator waiting through the server-side
  // note read and prior-message check; then require the exact seeded value.
  const chatComposer = page.getByPlaceholder("Message");
  await chatComposer.waitFor();
  expect(await chatComposer.inputValue()).toMatch(
    /About my note `\/repos\/notes\/.*\.md`:[\s\S]*confirmed at home/,
  );

  // Send it. This is the step that makes the platform PARSE the derived agent
  // path (create() + message()), so a path it would reject — the note's
  // filename stamp carries an uppercase T and Z — fails here instead of on a
  // phone. Only the echo of our own message is asserted; whatever the agent
  // says back is its own business.
  await page.getByLabel("Send").click();
  await page
    .getByText(/About my note/)
    .first()
    .waitFor();

  // The notes screen stayed mounted underneath the pushed chat — its row is
  // still open.
  await page.goBack();

  // The delete tombstone empties the list over the live stream.
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Yes, delete this note" }).click();
  await page.getByText("Nothing here yet").waitFor();
});
