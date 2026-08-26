// The notes feature through the real phone-sized web build: the GLOBAL
// capture composer (visible the moment the project opens — the feature's
// whole premise), a real capture appended to /notes with no AI in the path,
// the ✕→📝-pill collapse, the /notes screen's list, search, inline edit and
// delete confirm, and the 💬 hand-off into a conversation about a note. The title/tags analysis obligation runs server-side and is
// covered by apps/mobile/e2e/notes.e2e.test.ts (AI-dependent); assertions
// here stick to the note's own text, which is stable whether or not the
// derived title has landed yet.

import { expect } from "@playwright/test";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("captures a note from the global composer and manages it on /notes", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-notes-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  // Video-mode demos start at the interesting part: the project screen with
  // the composer already docked, not the OAuth signup ceremony.
  page.videoMode?.setStartTime();

  // The composer is already there on the chat-list screen — no navigation
  // between "I opened the app" and "I captured the thought".
  await page.getByText(`→ /notes in ${projectSlug}`).waitFor();
  await page.getByPlaceholder("Capture a note").fill("Standing desk height: 76cm felt right");
  await page.getByLabel("Save note").click();

  // ✕ collapses to the floating pill; the pill brings it back.
  await page.getByLabel("Close note composer").click();
  await page.getByPlaceholder("Capture a note").waitFor({ state: "hidden" });
  await page.getByLabel("Capture a note").click();
  await page.getByPlaceholder("Capture a note").waitFor();

  // The saved-confirmation is the shortcut to what you just made: tapping it
  // lands on the /notes screen, where the captured note renders (first-line
  // title until the analysis settlement overlays it — either way the text is
  // on screen).
  await page.getByText("view in /notes").click();
  await page.getByPlaceholder("Search notes…").waitFor();
  await page
    .getByText(/76cm felt right/)
    .first()
    .waitFor();

  // Client-side search over text.
  await page.getByPlaceholder("Search notes…").fill("standing desk");
  await page
    .getByText(/76cm felt right/)
    .first()
    .waitFor();
  await page.getByPlaceholder("Search notes…").fill("zzz-no-match");
  await page.getByText("No results").waitFor();
  await page.getByPlaceholder("Search notes…").fill("");

  // Tap to expand → edit the text inline; the updated event overlays it and
  // resets the derived title to the new first line.
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

  // 💬 opens the conversation ABOUT this note: its own thread, with a pointer
  // to the note already typed into the composer — the question under it is
  // the human's to write, so nothing is sent on the way in.
  await page.getByLabel("Chat about this note").click();
  // inputValue() does the waiting; expect only checks the string it returned.
  expect(await page.getByPlaceholder("Message").inputValue()).toMatch(
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

  // Back on /notes the note is untouched, and its row is still open — the
  // notes screen stayed mounted underneath the pushed chat.
  await page.goBack();

  // Inline two-step delete confirm → tombstone empties the list over the
  // live stream.
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Yes, delete this note" }).click();
  await page.getByText("Nothing here yet").waitFor();
});

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
    // A constant prefix, NOT the slug: the signup display name embeds this,
    // and a slug-containing name makes getByText(projectSlug) ambiguous.
    email: uniqueSignupEmail("mobile-notes"),
    projectSlug,
    testInfo,
  });
  // Project selection auto-continues for test identities (project-access.tsx)
  // — consent is the next interactive page.
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });
  // The app auto-opens the account's only project — no picker tap.
  await page.getByText("New chat").waitFor();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
