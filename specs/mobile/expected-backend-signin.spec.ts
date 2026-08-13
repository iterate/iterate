// Proof that the bundle's baked-in expectation reaches a REAL deployed auth
// screen: the sign-in screen shows the expected backend, Sign in opens the
// deployment's actual /oauth2/authorize (whose signed /login redirect must
// carry the login_hint — the @better-auth/oauth-provider patch), and the
// login page offers "Continue as <test email>" with the fixed test OTP
// prefilled after one press.
//
// The expectation is stamped into build-info.json at publish time
// (apps/mobile/scripts/write-build-info.mjs); the web dev bundle here is
// unstamped, so these specs seed the dev-only localStorage override
// (apps/mobile/src/lib/build-info.ts) — same values, same code paths.
//
// The deployed-auth spec needs APP_CONFIG_BASE_URL pointing at a deployed
// preview slot running this branch (CI's preview e2e lane always does;
// locally: `APP_CONFIG_BASE_URL=https://os.iterate-preview-N.com pnpm spec …`).
// Skipped otherwise — the stamp must name an envs.ts preset, and prd keeps
// the fixed test OTP off.

import { expect } from "@playwright/test";
import { deployedPreviewEnvs } from "../../envs.ts";
import { test } from "../test-support/test.ts";

const HINT_EMAIL = "spec-deeplink+test@nustom.com";

const target = deployedPreviewEnvs.find(
  (env) => env.baseUrl === process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, ""),
);

test("scanning the channel you're already on shows the bundle's expected backend", async ({
  page,
}) => {
  // Reassurance over magic: no silent redirect — the screen must SAY you're
  // already there (Current = Target) and what the running bundle expects.
  await page.addInitScript(() => {
    localStorage.setItem("preview-channel-override", "spec-chan");
    localStorage.setItem(
      "build-info-override",
      JSON.stringify({
        expectedBackendEnv: "preview_3",
        testLoginEmail: "spec-deeplink+test@nustom.com",
      }),
    );
  });
  await page.goto("/preview-channel/spec-chan");
  await page.getByText("You're on this channel").waitFor();
  await page.getByText("Expected backend").waitFor();
  // With the fix checkbox ticked, Continue would start the OAuth flow —
  // untick it to take the plain "just continue" path instead.
  await page.getByRole("checkbox", { name: /Sign in/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // The sign-in screen reads the SAME bundle stamp — nothing to ferry.
  await page.getByText("Expected backend for this build").waitFor();
  await page.getByText(`test sign-in as ${HINT_EMAIL}`).waitFor();
});

test("the bundle's expectation survives to a real auth screen with the test OTP prefilled", async ({
  page,
  context,
}) => {
  test.skip(!target, "needs APP_CONFIG_BASE_URL pointing at a deployed preview slot");

  await page.addInitScript(
    ([env, email]) => {
      localStorage.setItem(
        "build-info-override",
        JSON.stringify({ expectedBackendEnv: env, testLoginEmail: email }),
      );
    },
    [target!.dopplerConfig, HINT_EMAIL],
  );
  await page.goto("/");

  await page.getByText("Expected backend for this build").waitFor();
  // The test identity rides the recommendation card…
  await page.getByText(`test sign-in as ${HINT_EMAIL}`).waitFor();
  // …and the expected backend preselects the server field.
  await page.locator(`input[value="${target!.baseUrl}"]`).waitFor();

  // Sign in opens the REAL auth deployment in a popup (OIDC discovery +
  // client registration + authorize happen live against the slot).
  // timeout: cold cross-server auth navigation — no loading UI for the spinner waiter
  const popupPromise = context.waitForEvent("page", { timeout: 45_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;

  // The signed /login redirect carried the login_hint: the page offers the
  // hinted identity as its primary action.
  const continueAs = popup.getByRole("button", { name: `Continue as ${HINT_EMAIL}` });
  // timeout: the popup is outside the wrapped page, so no spinner waiter covers it
  await continueAs.waitFor({ timeout: 45_000 });
  await continueAs.click();

  // One press later: the normal OTP screen, code already filled with the
  // fixed test OTP. The user only confirms.
  await popup
    .getByText(`Enter the 6-digit code sent to ${HINT_EMAIL}`)
    // timeout: unwrapped popup — the spinner waiter cannot see it
    .waitFor({ timeout: 30_000 });
  await expect
    // timeout: unwrapped popup — the spinner waiter cannot see it
    .poll(() => popup.getByTestId("email-otp-input").inputValue(), { timeout: 10_000 })
    .toBe("424242");
});
