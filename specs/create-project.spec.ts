import { expect } from "@playwright/test";
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
  // The spinner-waiter runs here like everywhere else — the /projects pending
  // state and the agent page's loading state are honest loading UI, and
  // middlewright's spinner check has been multi-element-safe since
  // iterate/middlewright#3 (this spec used to sit the middleware out).
  //
  // Back on OS after auth first-run onboarding: a single project enters its
  // creation flow, which hands off to the onboarding agent once ready. The
  // composer is that route's structural chrome (renders on mount, no LLM
  // output involved); 60s carried over from the waitForURL this replaced —
  // cold-slot bootstrap + redirect straggle can outlast the spinner-waiter's 30s timeout ceiling.
  await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  // The composer only renders under an agent-stream route, so the URL has
  // settled — assert we landed on the FIRST project's onboarding agent.
  expect(page.url()).toContain(`/projects/${firstSlug}/agents/streams/agents/onboarding`);

  // /new-project is the deep-linked create sheet (sidebar + projects list
  // both link here). Navigate directly so strict-mode locators don't have
  // to disambiguate multiple "Create project" controls.
  await page.goto("/new-project");

  await page.getByLabel("Slug").fill(slug);
  // Create resolves after the atomic birth batch, then project home shows
  // the bootstrap saga and hands off to onboarding once ready. The composer
  // is that destination's structural chrome; 60s covers the cold birth +
  // saga + handoff — past the spinner-waiter's 30s timeout ceiling.
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 }); // timeout: cold birth + saga + handoff outlast the spinner-waiter's 30s ceiling
  // After the checklist completes, welcome handoff lands on onboarding.
  expect(page.url()).toContain(`/projects/${slug}/agents/streams/agents/onboarding`);
});
