// personal-access-tokens.spec.ts — the sessions page mints a PERSONAL ACCESS TOKEN (one OAuth
// grant: 30 days, scoped to the projects chosen, shown once) and lists it beside the browser's own
// session; revoking it from that list refuses the bearer. The /account page is the LiveState half of
// the account: the user's sign-ins, live from `session.user`'s account facet — no loader re-fetch,
// no reload (contrast live-state-demo.spec, which proves the same for /demo).
//
// SWAPPABLE like the other specs: DEMO_BASE_URL points it at a deployment; otherwise a local worker
// is booted (playwright.config.ts). Sign-in uses the admin-secret bearer fixture (ADMIN_API_SECRET,
// or dev-admin-api-secret locally) so it works local and deployed.
import { expect, test } from "@playwright/test";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded probe of the minted bearer; the page itself uses the app's real WebSocket.
import { newHttpBatchRpcSession } from "capnweb";
import type { IterateRpcTarget } from "../src/session.ts";

const adminSecret = process.env.ADMIN_API_SECRET || "dev-admin-api-secret";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

let email: string;
test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  email = `personal-access-token-${stamp()}@example.com`;
  const login = await page.request.post(`${origin}/login`, {
    headers: { Authorization: `Bearer ${adminSecret}` },
    form: { email, next: "/" },
    maxRedirects: 0,
  });
  expect(login.status(), await login.text().catch(() => "")).toBe(302);
});

test("the account page is live: a sign-in appears the instant the platform's fact is reduced", async ({
  page,
}) => {
  await page.goto("/account");
  // The whole page is useLiveState over session.user's account facet — it connects and goes live.
  await expect(page.getByTestId("status")).toHaveText("live");
  // The processor subscribes from its enable, so the sign-in that opened THIS page may predate it. A
  // fresh page is a fresh /api session: a new authentication fact, folded into the view it renders.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText("live");
  await expect(page.getByTestId("signin-count")).not.toHaveText("0");
  await expect(page.getByTestId("signins")).toContainText("from-server-cookie");
});

test("a personal access token: minted once from the sessions page, listed beside the browser session, the user's bearer on /api, revoked from the list", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const project = `personal-access-token-${stamp()}`;
  // A token is scoped to projects the user reaches — make one on the dashboard first.
  await page.goto("/");
  await page.getByRole("textbox", { name: "New project" }).fill(project);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: "open", exact: true }).waitFor();

  await page.goto("/sessions");
  await page.getByRole("textbox", { name: "Token name" }).fill("CI robot");
  await expect(page.getByRole("checkbox", { name: project, exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Create personal access token", exact: true }).click();
  // Shown once, right here …
  const minted = page.getByTestId("minted-token");
  await expect(minted).toBeVisible();
  const token = (await minted.textContent())!.trim();
  expect(token.length).toBeGreaterThan(20);
  // … and listed beside the browser's own session, as what it is.
  const row = page.getByRole("row").filter({ hasText: "CI robot" });
  await expect(row).toContainText("Personal access token");
  await expect(page.getByRole("row").filter({ hasText: "(this browser)" })).toHaveCount(1);

  // The bearer IS the user on /api.
  {
    // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded whoami with the minted bearer.
    using api = newHttpBatchRpcSession<IterateRpcTarget>(
      new Request(`${origin}/api`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect((await api.authenticate({ type: "from-server-cookie" }).whoami()).email).toBe(email);
  }

  // Dismissed, the token is gone from the page — it was shown once.
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(minted).toHaveCount(0);

  // Revoked from the list: the row leaves, and the bearer is refused.
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "CI robot" })).toHaveCount(0);
  const refused = await page.request.post(`${origin}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(refused.status()).toBe(401);
});
