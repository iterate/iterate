import type { Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";

/**
 * Real signup through the apps/auth email-OTP lane. Non-production auth
 * accepts the fixed code 424242 for `+test@nustom.com` addresses without sending mail
 * (apps/auth/src/server/auth-plugins.ts), so this drives the exact flow a
 * human sees: OS login → auth login (email OTP) → org/project onboarding
 * → back to OS signed in. Nustom test users auto-join the shared Iterate
 * organization, so they land back in OS and create their requested first
 * project there.
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
export async function startEmailOtpSignIn(page: Page) {
  await page.goto("/api/iterate-auth/login?login_hint=email");
  await page.getByText("Sign in to your Iterate account").waitFor();
  return await page.getByTestId("email-input").isVisible();
}

/**
 * Call after {@link startEmailOtpSignIn}. Ends signed in on OS with one
 * project container (slug `input.projectSlug`) created.
 */
export async function signUpWithEmailOtp(
  page: Page,
  input: { email: string; projectSlug: string },
) {
  await page.getByTestId("email-input").fill(input.email);
  await page.getByTestId("email-submit-button").click();
  await page.getByTestId("email-otp-input").fill("424242");
  await page.getByTestId("email-verify-button").click();

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    const organizationNameInput = page.getByLabel("Organization name");
    const destination = await Promise.race([
      organizationNameInput.waitFor({ timeout: 30_000 }).then(() => "auth-onboarding" as const),
      page.waitForURL("**/projects", { timeout: 30_000 }).then(() => "os-projects" as const),
    ]);

    if (destination === "auth-onboarding") {
      // A brand-new user with no organization parks on auth's first-run
      // onboarding: organization name and first project slug in one form.
      await organizationNameInput.fill(`Playwright ${input.email.split("@")[0]}`);
      await page.getByLabel("Project slug").fill(input.projectSlug, { timeout: 15_000 });
      await page.getByRole("button", { name: "Get started" }).click({ timeout: 15_000 });
      return;
    }

    // Nustom-domain users are auto-joined to the shared Iterate organization
    // and return to OS without auth's organization-creation form.
    await page.goto("/new-project");
    await page.getByLabel("Slug").fill(input.projectSlug, { timeout: 15_000 });
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
  });
}
