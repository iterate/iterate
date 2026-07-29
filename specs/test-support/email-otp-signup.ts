import type { Page, TestInfo } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { waitForPreviewRolloutBeforeProjectCreation } from "@iterate-com/shared/test-support/preview-rollout-gate";

/**
 * Real signup through the apps/auth email-OTP lane. Non-production auth
 * accepts the fixed code 424242 for `+test@nustom.com` addresses without sending mail
 * (apps/auth/src/server/auth-plugins.ts), so this drives the exact flow a
 * human sees: OS login → auth login (email OTP) → first-run onboarding
 * (organization + first project in one form) → back to OS signed in.
 *
 * The lane only exists where the auth deployment enables it
 * (APP_CONFIG_EMAIL_OTP_ENABLED, default on for dev stages; OS mirrors it as
 * APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED) — check with
 * {@link startEmailOtpSignIn} and skip otherwise.
 *
 * Entry is the OS auth handler's login URL with `login_hint=email` rather
 * than the "Sign in with email" button on /sign-in: that button is gated on
 * the public config's `iterateAuth.emailOtpEnabled`, which getPublicConfig
 * currently drops (optional config objects lose their public fields), so the
 * button never renders even when the lane works.
 */

export function uniqueSignupEmail(prefix: string) {
  const random = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${random}+test@nustom.com`.toLowerCase();
}

/**
 * Lands on the auth app's login page in email mode. Resolves false when the
 * deployment doesn't offer email OTP sign-in.
 */
export async function startEmailOtpSignIn(page: Page, testInfo: TestInfo) {
  // Preview teardown leaves a parked OS Worker behind. During a fresh edge
  // rollout, even the exact-version request can briefly reach that 503
  // predecessor, so consume the existing rollout boundary before the first
  // OS navigation rather than waiting later at project creation.
  await waitForPreviewRolloutBeforeProjectCreation({
    beforeWait: (waitMs) => testInfo.setTimeout(testInfo.timeout + waitMs),
  });
  await page.goto("/api/iterate-auth/login?login_hint=email");
  await page.getByText("Sign in to your iterate account").waitFor();
  return await page.getByTestId("email-input").isVisible();
}

/**
 * Call after {@link startEmailOtpSignIn}. Ends signed in on OS with one fresh
 * organization and one project container (slug `input.projectSlug`) created
 * by the onboarding form.
 */
export async function signUpWithEmailOtp(
  page: Page,
  input: { email: string; projectSlug: string; testInfo: TestInfo },
) {
  await page.getByTestId("email-input").fill(input.email);
  await page.getByTestId("email-submit-button").click();
  await page.getByTestId("email-otp-input").fill("424242");
  await page.getByTestId("email-verify-button").click({ timeout: 15_000 });

  // A brand-new user has no organization, so the OAuth post-login flow parks
  // on the auth app's first-run onboarding — organization name and first
  // project slug in one form. The page loads behind an unmarked skeleton, so
  // spinner-waiter can't help here — wait for the form directly instead.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page
      .getByLabel("Organization name")
      .fill(`Playwright ${input.email.split("@")[0]}`, { timeout: 30_000 });
    await page.getByLabel("Project slug").fill(input.projectSlug, { timeout: 15_000 });
    await waitForPreviewRolloutBeforeProjectCreation({
      beforeWait: (waitMs) => input.testInfo.setTimeout(input.testInfo.timeout + waitMs),
    });
    await page.getByRole("button", { name: "Get started" }).click({ timeout: 15_000 });
  });
}
