import { connectItxReady } from "iterate/node";
import { interceptor } from "@iterate-com/test-support";
import type { Page } from "@playwright/test";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";

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
export async function startEmailOtpSignIn(page: Page) {
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
  input: { email: string; projectSlug: string; osBaseUrl: string | undefined },
) {
  await page.getByTestId("email-input").fill(input.email);
  await page.getByTestId("email-submit-button").click();
  // The submit crosses an auth-server action before the OTP form mounts; the
  // button shows "Sending code..." meanwhile, so the spinner-waiter extends
  // the wait — no manual budget.
  const emailOtpInput = page.getByTestId("email-otp-input");
  await emailOtpInput.waitFor({ state: "visible" });
  await emailOtpInput.fill("424242");
  await page.getByTestId("email-verify-button").click();

  // A brand-new user has no organization, so the OAuth post-login flow parks
  // on the auth app's first-run onboarding — organization name and first
  // project slug in one form. "Signing in..." persists through the redirect
  // (redirectAndStayPending) and the onboarding skeleton is loading-marked,
  // so the spinner-waiter rides real product UI the whole way.
  await page.getByLabel("Organization name").fill(`Playwright ${input.email.split("@")[0]}`);
  await page.getByLabel("Project slug").fill(input.projectSlug);
  if (!input.osBaseUrl) throw new Error("OS base URL is required for signup fixtures");
  // Auth creates the real directory record. Configure its known onboarding
  // caller before returning to OS; the browser still starts the real project
  // bootstrap with its own signed-in identity.
  const config = readOsPlaywrightAuthConfig();
  using session = await connectItxReady({
    baseUrl: input.osBaseUrl,
    auth: { type: "admin-secret", secret: config.adminApiSecret },
  });
  await page.route(
    "**/api/orpc/project/create",
    async (route) => {
      const response = await route.fetch();
      if (response.ok()) {
        const result = (await response.json()).json;
        using project = session.projects.get(result.id);
        await interceptor.configureOnboarding(project);
      }
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const [response] = await Promise.all([
    // timeout: held RPC setup has no spinner-waiter network tracking; match its 30s ceiling.
    page.waitForResponse("**/api/orpc/project/create", { timeout: 30_000 }),
    page.getByRole("button", { name: "Get started" }).click(),
  ]);
  if (!response.ok()) throw new Error(`Signup project create failed: ${response.status()}`);
  const result = (await response.json()).json;
  using project = session.projects.get(result.id);
  // Observe birth without nudging the project processor: the browser owns it.
  await project.streams.get("/").waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/project/created"],
    timeoutMs: 60_000,
  });
  await interceptor.configureAgentModels(project);
}
