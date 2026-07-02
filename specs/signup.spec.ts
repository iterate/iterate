import { spinnerWaiter } from "middlewright";
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
    "Email OTP sign-in is disabled for this deployment (VITE_ENABLE_EMAIL_OTP_SIGNIN on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  await signUpWithEmailOtp(page, { email: uniqueSignupEmail("signup") });

  // Back on OS, signed in: a fresh user has no projects yet. The /projects
  // pending state renders its data-spinner section twice during the redirect,
  // which trips spinner-waiter's strict-mode isVisible — sit it out. The
  // OAuth callback straggles on cold slots, so give this test extra budget
  // (the waitFor must stay under the test timeout or Playwright kills the
  // test before the locator resolves).
  test.setTimeout(180_000);
  await spinnerWaiter.settings.run({ disabled: true }, () =>
    page.getByText("No projects yet").waitFor({ timeout: 90_000 }),
  );
});
