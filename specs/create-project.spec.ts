import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { test } from "./test-support/test.ts";

// Deviation from the suite's forged-session fixture pattern: this spec uses a
// freshly signed-up user, not a forged session. Creating a project mints new
// auth claims, and only a real session can refresh its access token to pick
// up the new project claim the post-create navigation authorizes with.
test("a new user can create a project through the UI form", async ({ page }, testInfo) => {
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );
  const firstSlug = uniqueFixtureSlug("first-project");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("create-project"),
    projectSlug: firstSlug,
    testInfo,
  });

  const slug = uniqueFixtureSlug("create-project");
  // spinner-waiter is disabled through here: the /projects pending state and
  // the project page's loading state can render two spinner-matching elements
  // at once, tripping its strict-mode isVisible.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // Back on OS after auth first-run onboarding: the initial project enters
    // its creation flow and lands on its dashboard once bootstrap completes.
    await page.getByTestId("project-dashboard").waitFor({ timeout: 60_000 });
  });
  expect(new URL(page.url())).toMatchObject({ pathname: `/projects/${firstSlug}` });

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // /new-project is the deep-linked create sheet (sidebar + projects list
    // both link here). Navigate directly so strict-mode locators don't have
    // to disambiguate multiple "Create project" controls.
    await page.goto("/new-project");

    await page.getByLabel("Slug").fill(slug, { timeout: 15_000 });
    // Create resolves after the atomic birth batch, then project home shows
    // the bootstrap saga and the dashboard once ready.
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
    await page.getByTestId("project-dashboard").waitFor({ timeout: 60_000 });
  });
  expect(new URL(page.url())).toMatchObject({ pathname: `/projects/${slug}` });
});
