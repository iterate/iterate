// account-live.spec.ts — the /_auth/account console page is driven ENTIRELY by useLiveState. Sign
// in, open the page, create a token: the row appears the instant the account processor reduces the
// command and the delta streams back — no loader re-fetch, no reload. The "just use LiveState" proof
// as a real control-plane route (contrast live-state-demo.spec, which proves the same for /demo).
//
// SWAPPABLE like the other specs: DEMO_BASE_URL points it at a deployment; otherwise a local worker
// is booted (playwright.config.ts). Sign-in uses the admin-secret bearer fixture (ADMIN_API_SECRET,
// or dev-admin-api-secret locally) so it works local and deployed.
import { expect, test } from "@playwright/test";

const adminSecret = process.env.ADMIN_API_SECRET || "dev-admin-api-secret";

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const login = await page.request.post(`${origin}/login`, {
    headers: { Authorization: `Bearer ${adminSecret}` },
    form: { email: `account-live-${Date.now()}@example.com`, next: "/" },
    maxRedirects: 0,
  });
  expect(login.status(), await login.text().catch(() => "")).toBe(302);
});

test("the account page renders live and a created token appears instantly", async ({ page }) => {
  await page.goto("/account");
  // The whole page is useLiveState over session.user's account facet — it connects and goes live.
  await expect(page.getByTestId("status")).toHaveText("live");
  // No token yet; creating one is a single appended command.
  await expect(page.getByTestId("token-count")).toHaveText("0");
  await page.getByRole("textbox", { name: "Token name" }).fill("My live token");
  await page.getByRole("button", { name: "Create token" }).click();
  // It appears the instant the processor reduces the command and the delta arrives — no reload.
  await expect(page.getByTestId("token-count")).toHaveText("1");
  await expect(page.getByTestId("tokens")).toContainText("My live token");
});
