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
test("can sign up with an email one-time passcode", async ({ page }, testInfo) => {
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("signup");
  // Back on OS, signed in: auth created the first project's container
  // on auth, and the root `/` starts the engine bootstrap. The creation panel
  // is deliberately transient (and can be hidden in a responsive side panel),
  // so it is not a completion signal. Assert the durable destination below.
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("signup"),
    projectSlug: slug,
    testInfo,
  });

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The default config template handles project/created, creates its
    // onboarding agent, and drives the connected OS tab to the new chat.
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });
  expect(new URL(page.url())).toMatchObject({
    pathname: `/projects/${slug}/agents/streams/agents/onboarding`,
  });

  // Ordinary OS entry returns to the ready project's dashboard.
  await page.goto("/");
  await page.getByTestId("project-dashboard").waitFor();
  expect(new URL(page.url())).toMatchObject({ pathname: `/projects/${slug}` });
});
