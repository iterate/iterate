import { spinnerWaiter } from "middlewright";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { test, uniqueSlug } from "./test-support/test.ts";

// Deviation from the suite's forged-session fixture pattern: this spec's whole
// point is the REAL signup flow (goal 1 of the itx-v4 migration), so it drives
// the apps/auth email-OTP lane instead of minting a session.
test("can sign up with an email one-time passcode", async ({ page }) => {
  test.skip(
    !(await startEmailOtpSignIn(page)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueSlug("signup");
  await signUpWithEmailOtp(page, { email: uniqueSignupEmail("signup"), projectSlug: slug });

  // Back on OS, signed in: onboarding created the first project's container
  // on auth, and the root `/` starts the engine bootstrap and redirects
  // server-side straight to the onboarding agent stream. The agent page's
  // loading states render two spinner-matching elements at once, which trips
  // spinner-waiter's strict-mode isVisible — sit it out. The cold-slot
  // OAuth-callback straggle traced back to zombie worker routes, which the
  // deploy now verifies + heals (tasks/os-cold-create-latency.md).
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.waitForURL(`**/projects/${slug}/agents/streams/agents/onboarding`, {
      timeout: 60_000,
    });
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });
});
