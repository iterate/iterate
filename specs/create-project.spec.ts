import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { test, uniqueSlug } from "./test-support/test.ts";

// Deviation from the suite's forged-session fixture pattern: this spec uses a
// freshly signed-up user, not a forged session. Creating a project mints new
// auth claims, and only a real session can refresh its access token to pick
// up the new project claim the post-create navigation authorizes with.
test("a new user can create a project through the UI form", async ({ page }) => {
  test.skip(
    !(await startEmailOtpSignIn(page)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );
  const firstSlug = uniqueSlug("first-project");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("create-project"),
    projectSlug: firstSlug,
  });

  const slug = uniqueSlug("create-project");
  // spinner-waiter is disabled through here: the /projects pending state and
  // the agent page's loading state both render two spinner-matching elements
  // at once, tripping its strict-mode isVisible.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // Back on OS after auth first-run onboarding: a single project goes
    // straight to its onboarding agent while project bootstrap catches up.
    // The composer is that route's structural chrome (renders on mount, no
    // LLM output involved); 60s carried over from the waitForURL this
    // replaced — cold-slot bootstrap + redirect can straggle.
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });
  // The composer only renders under an agent-stream route, so the URL has
  // settled — assert we landed on the FIRST project's onboarding agent.
  expect(page.url()).toContain(`/projects/${firstSlug}/agents/streams/agents/onboarding`);

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // /projects is the home of SUBSEQUENT projects: the header's "New project"
    // and the sidebar's icon both link here, but share an accessible name, so
    // navigate directly instead of picking one with a strict-mode locator.
    await page.goto("/new-project");

    await page.getByLabel("Slug").fill(slug, { timeout: 15_000 });
    // Create resolves as soon as the project identity and bootstrap events
    // exist, then redirects straight to the onboarding agent stream; repo and
    // worker readiness continue behind that route. The composer is the
    // destination's structural chrome; 60s covers the redirect plus the
    // bootstrap still catching up behind it.
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });
  // Same reasoning as above, now for the project created through the form.
  expect(page.url()).toContain(`/projects/${slug}/agents/streams/agents/onboarding`);
});
