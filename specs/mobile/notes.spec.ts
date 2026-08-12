// The notes feature through the real phone-sized web build: the GLOBAL
// capture composer (visible the moment the project opens — the feature's
// whole premise), a real capture appended to /notes with no AI in the path,
// the ✕→📝-pill collapse, and the /notes screen's list, search, and inline
// delete confirm. The title/tags analysis obligation runs server-side and is
// covered by apps/mobile/e2e/notes.e2e.test.ts (AI-dependent); assertions
// here stick to the note's own text, which is stable whether or not the
// derived title has landed yet.

import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("captures a note from the global composer and manages it on /notes", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-notes-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);

  // The composer is already there on the chat-list screen — no navigation
  // between "I opened the app" and "I captured the thought".
  await page.getByText(`→ /notes in ${projectSlug}`).waitFor();
  await page.getByPlaceholder("Capture a note").fill("Standing desk height: 76cm felt right");
  await page.getByLabel("Save note").click();
  await page.getByText("Note saved").waitFor();

  // ✕ collapses to the floating pill; the pill brings it back.
  await page.getByLabel("Close note composer").click();
  await page.getByPlaceholder("Capture a note").waitFor({ state: "hidden" });
  await page.getByLabel("Capture a note").click();
  await page.getByPlaceholder("Capture a note").waitFor();

  // The /notes screen: the captured note renders (first-line title until the
  // analysis settlement overlays it — either way the text is on screen).
  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/notes" }).click();
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

  // Tap to expand → inline two-step delete confirm → tombstone empties the
  // list over the live stream.
  await page
    .getByText(/76cm felt right/)
    .first()
    .click();
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
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15_000 });
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });
  await page.getByText(projectSlug).click();
  await page.getByText("New chat").waitFor();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
