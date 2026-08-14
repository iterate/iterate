// Proof that the bundle's baked-in expectation drives a one-tap sign-in
// against a REAL deployed auth worker: the sign-in screen shows the expected
// backend, Sign in routes the browser through the deployment's /test-login
// (apps/auth/src/server/test-login.ts — server-side fixed-OTP sign-in, then
// straight into the authorize URL), project selection auto-continues for the
// test identity, and the first interactive page is the consent screen — the
// deliberate "userland client" moment. Allowing access completes the code
// exchange and the app lands in the identity's only project, no picker.
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

test("one tap signs the test identity in: consent is the only stop before the project", async ({
  page,
  context,
}) => {
  test.skip(target === undefined, "needs APP_CONFIG_BASE_URL pointing at a deployed preview slot");

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
  // client registration happen live against the slot) — routed through
  // /test-login, so the login page and OTP screen never appear.
  // timeout: cold cross-server auth navigation — no loading UI for the spinner waiter
  const popupPromise = context.waitForEvent("page", { timeout: 45_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;

  // First interactive page: consent, already signed in as the hinted
  // identity with project selection auto-continued behind the scenes. This
  // stop is deliberate — the mobile app is an untrusted userland client.
  // timeout: unwrapped popup (no spinner waiter) + first-visit /test-login seeding
  await popup.getByText("Allow Iterate (iOS)?").waitFor({ timeout: 45_000 });
  await popup.getByRole("button", { name: "Allow access" }).click();

  // Allowing access finishes the code exchange; the app opens the identity's
  // only project directly ("New chat" is the project chat screen) — no
  // project picker for a single-project account.
  // timeout: popup handoff + cold OS-side backfill create, both outside the spinner waiter
  await page.getByText("New chat").waitFor({ timeout: 90_000 });
});
