import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { test } from "./test-support/test.ts";

// Deviation from the suite's forged-session fixture pattern: this spec's whole
// point is the REAL signup flow (goal 1 of the itx-v4 migration), so it drives
// the apps/auth email-OTP lane instead of minting a session.
test("can sign up with an email one-time passcode", async ({ page }) => {
  test.skip(
    !(await startEmailOtpSignIn(page)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("signup");
  // Back on OS, signed in: onboarding created the first project's container
  // on auth, and the root `/` starts the engine bootstrap. Project home shows
  // the creation saga, then its explicit welcome flow hands off to the
  // onboarding agent. Those loading states can render two spinner-matching
  // elements at once, which trips spinner-waiter's strict-mode isVisible —
  // sit it out. The cold-slot
  // OAuth-callback straggle traced back to zombie worker routes, which the
  // deploy now verifies + heals (tasks/os-cold-create-latency.md).
  // Start watching before submitting signup so a fast local bootstrap cannot
  // make the creation UI disappear before the spec observes it.
  await Promise.all([
    signUpWithEmailOtp(page, { email: uniqueSignupEmail("signup"), projectSlug: slug }),
    spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByTestId("project-creation-progress").waitFor({ timeout: 60_000 }),
    ),
  ]);

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The composer is the destination route's structural chrome — it renders
    // on mount, independent of any LLM output. 60s (carried over from the
    // waitForURL this replaced) covers the cold-slot bootstrap + redirect
    // straggle described above.
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });
  // The composer only renders under an agent-stream route, so the URL has
  // settled — assert the redirect landed on the new project's onboarding agent.
  expect(page.url()).toContain(`/projects/${slug}/agents/streams/agents/onboarding`);

  // `onboardingActive` keeps the manual "Continue onboarding" affordance,
  // but ordinary OS entry must not turn that durable state into an automatic
  // agent redirect.
  await page.goto("/");
  await page.getByRole("link", { name: "Continue onboarding" }).waitFor();
  expect(new URL(page.url())).toMatchObject({ pathname: `/projects/${slug}` });
});
