// The mobile integration catalogue through the real phone-sized web build.
// A fresh project intentionally has no third-party credentials: the useful
// deterministic boundary is real signup → project drawer → real
// integrations.list()/getConnection() reads → every connect surface. Provider
// OAuth and Telegram token validation stop at external systems and do not get
// faked into a misleading green test.

import { expect } from "@playwright/test";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("opens the project integration catalogue from the mobile drawer", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-integrations-${Date.now().toString(36)}`;

  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  // This event begins only after issuer discovery, OIDC discovery, and dynamic
  // client registration on another worker. It is not a UI action a visible
  // spinner can extend, and a cold preview regularly needs more than 1s.
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  // The popup is outside middlewright's wrapped page and may still be crossing
  // a cold auth-worker navigation, so it gets the repo's cross-server bound.
  await popup.getByTestId("email-login-button").click({ timeout: 15_000 });
  await signUpWithEmailOtp(popup, {
    email: uniqueSignupEmail("mobile-integrations"),
    projectSlug,
    testInfo,
  });
  await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15_000 });
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });

  await page.getByText(projectSlug).click();
  await page.getByText("New chat").waitFor();
  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "Integrations" }).click();

  await page.getByText("Connectable integrations", { exact: true }).waitFor();
  await expect.poll(() => page.getByText("Not connected", { exact: true }).count()).toBe(4);
  await expect
    .poll(() => page.getByRole("button", { name: "Connect", exact: true }).count())
    .toBe(5);
  await page.getByText("Slack", { exact: true }).waitFor();
  await page.getByText("Google", { exact: true }).waitFor();
  await page.getByText("GitHub", { exact: true }).waitFor();
  await page.getByText("Telegram", { exact: true }).waitFor();
  await page.getByText("Account connections", { exact: true }).waitFor();

  await page.getByText("Built-in integrations", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("itx.integrations.parallel", { exact: true }).waitFor();
  await page.getByText("itx.mcp.exa", { exact: true }).waitFor();
  await page.getByText("itx.ai", { exact: true }).waitFor();
});

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
