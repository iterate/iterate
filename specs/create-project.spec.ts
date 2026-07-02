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
    "Email OTP sign-in is disabled for this deployment (VITE_ENABLE_EMAIL_OTP_SIGNIN on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );
  await signUpWithEmailOtp(page, { email: uniqueSignupEmail("create-project") });

  const slug = uniqueSlug("create-project");
  // spinner-waiter is disabled through here: the /projects pending state and
  // the agent page's loading state both render two spinner-matching elements
  // at once, tripping its strict-mode isVisible.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The cold-slot 30-90s OAuth-callback parks traced back to zombie worker
    // routes (deploy now verifies + heals them; tasks/os-cold-create-latency.md).
    // On a healthy slot this renders in ~1s.
    await page.getByRole("button", { name: "Create new project" }).click({ timeout: 30_000 });

    await page.getByLabel("Slug").fill(slug, { timeout: 15_000 });
    // Create resolves as soon as the project EXISTS (identity + bootstrap
    // events) and redirects straight into the project — the bootstrap saga is
    // still running at this point.
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
    await page.waitForURL(`**/projects/${slug}`, { timeout: 30_000 });

    // The home page plays the live creation checklist from processor pushes…
    await page.getByTestId("project-creation-progress").waitFor({ timeout: 15_000 });
    // …and hands over to the settings view the moment `project/created` lands.
    await page.getByTestId("project-settings-panel").waitFor({ timeout: 60_000 });
  });
});
