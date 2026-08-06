// Proof that preview deep-link hints ferry all the way into a REAL deployed
// auth screen: the sign-in screen shows the recommended backend, Sign in
// opens the deployment's actual /oauth2/authorize (whose signed /login
// redirect must carry the login_hint — the @better-auth/oauth-provider patch),
// and the login page offers "Continue as <test email>" with the fixed test
// OTP prefilled after one press.
//
// The email hint is deliberately passed with a LITERAL `+` (which URL query
// parsing decodes as a space): expo-router's native deep-link extraction
// double-decodes `%2B` into exactly that corruption on device (see
// apps/mobile/src/lib/deep-link-hints.ts), so this spec drives the same
// mangled value a phone delivers and proves the normalization recovers it.
//
// Needs APP_CONFIG_BASE_URL pointing at a deployed preview slot running this
// branch (CI's preview e2e lane always does; locally:
// `APP_CONFIG_BASE_URL=https://os.iterate-preview-N.com pnpm spec …`).
// Skipped otherwise — the hint must name an envs.ts preset, and prd keeps
// the fixed test OTP off.

import { expect } from "@playwright/test";
import { deployedPreviewEnvs } from "../../envs.ts";
import { test } from "../test-support/test.ts";

const HINT_EMAIL = "spec-deeplink+test@nustom.com";

const target = deployedPreviewEnvs.find(
  (env) => env.baseUrl === process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, ""),
);

test("deep-link hints survive to a real auth screen with the test OTP prefilled", async ({
  page,
  context,
}) => {
  test.skip(target === undefined, "needs APP_CONFIG_BASE_URL pointing at a deployed preview slot");

  // Literal `+` → parsed as a space, the exact corruption a phone produces.
  await page.goto(`/?env=${target!.dopplerConfig}&email=${HINT_EMAIL.replace("@", "%40")}`);

  await page.getByText("Recommended backend for this preview channel").waitFor();
  // The normalized email (space → `+`) rides the recommendation card…
  await page.getByText(`test sign-in as ${HINT_EMAIL}`).waitFor();
  // …and the recommended backend preselects the server field.
  await page.locator(`input[value="${target!.baseUrl}"]`).waitFor();

  // Sign in opens the REAL auth deployment in a popup (OIDC discovery +
  // client registration + authorize happen live against the slot).
  const popupPromise = context.waitForEvent("page", { timeout: 45_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;

  // The signed /login redirect carried the login_hint: the page offers the
  // hinted identity as its primary action.
  const continueAs = popup.getByRole("button", { name: `Continue as ${HINT_EMAIL}` });
  await continueAs.waitFor({ timeout: 45_000 });
  await continueAs.click();

  // One press later: the normal OTP screen, code already filled with the
  // fixed test OTP. The user only confirms.
  await popup
    .getByText(`Enter the 6-digit code sent to ${HINT_EMAIL}`)
    .waitFor({ timeout: 30_000 });
  await expect
    .poll(() => popup.getByTestId("email-otp-input").inputValue(), { timeout: 10_000 })
    .toBe("424242");
});
