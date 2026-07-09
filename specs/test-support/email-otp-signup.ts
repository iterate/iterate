import type { Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";

/**
 * Real signup through the apps/auth email-OTP lane. Non-production auth
 * accepts the fixed code 424242 for `+test@nustom.com` addresses without sending mail
 * (apps/auth/src/server/auth-plugins.ts), so this drives the exact flow a
 * human sees: OS login → auth login (email OTP) → org/project onboarding
 * → back to OS signed in. Nustom test users auto-join the shared Iterate
 * organization, so auth may show project-only access setup instead of the
 * first-organization form.
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
    const projectSlugInput = page.getByLabel("Project slug");
    const destination = await Promise.race([
      page
        .getByRole("heading", { name: "Create your organization" })
        .waitFor({ timeout: 30_000 })
        .then(() => "auth-create-organization" as const),
      page
        .getByRole("heading", { name: "Create a project" })
        .waitFor({ timeout: 30_000 })
        .then(() => "auth-create-project" as const),
      page
        .getByRole("heading", { name: "Choose project access" })
        .waitFor({ timeout: 30_000 })
        .then(() => "auth-choose-project-access" as const),
      waitForOsProjects(page, 30_000).then(() => "os-projects" as const),
    ]);

    if (destination === "auth-create-organization") {
      // A brand-new user with no organization parks on auth's first-run
      // onboarding: organization name and first project slug in one form.
      await organizationNameInput.fill(`Playwright ${input.email.split("@")[0]}`);
      await projectSlugInput.fill(input.projectSlug, { timeout: 15_000 });
      await page.getByRole("button", { name: "Get started" }).click({ timeout: 15_000 });
      await continueOAuthProjectSelectionIfNeeded(page);
      return;
    }

    if (destination === "auth-create-project") {
      // Auto-joined users already have an organization, so auth asks only for
      // the first project before it can finish the OAuth project selection.
      await projectSlugInput.fill(input.projectSlug, { timeout: 15_000 });
      await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
      await continueOAuthProjectSelectionIfNeeded(page);
      return;
    }

    if (destination === "auth-choose-project-access") {
      // The shared organization may already have projects. Create the requested
      // one and select it for this OAuth grant instead of continuing with an
      // unrelated existing project.
      await page.getByRole("button", { name: "New project" }).click({ timeout: 15_000 });
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Project slug").fill(input.projectSlug, { timeout: 15_000 });
      await dialog.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
      await dialog.waitFor({ state: "hidden", timeout: 30_000 });
      await continueOAuthProjectSelectionIfNeeded(page);
      return;
    }

    // Nustom-domain users are auto-joined to the shared Iterate organization
    // and return to OS without auth's organization-creation form.
    await page.goto("/new-project");
    await page.getByLabel("Slug").fill(input.projectSlug, { timeout: 15_000 });
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
  });
}

async function continueOAuthProjectSelectionIfNeeded(page: Page) {
  const destination = await Promise.race([
    waitForOsProjects(page, 60_000).then(() => "os" as const),
    page
      .getByRole("button", { name: "Continue" })
      .waitFor({ timeout: 60_000 })
      .then(() => "auth-project-selection" as const),
  ]);

  if (destination === "auth-project-selection") {
    await page.getByRole("button", { name: "Continue" }).click({ timeout: 15_000 });
  }
}

async function waitForOsProjects(page: Page, timeout: number) {
  await page.waitForURL(
    (url) => url.pathname === "/projects" || url.pathname.startsWith("/projects/"),
    { timeout },
  );
}
