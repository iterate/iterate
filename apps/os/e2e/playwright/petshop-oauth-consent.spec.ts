// The human half of an OAuth connect, in a real browser: land on the deployed
// dummy-petshop consent page, approve, and come back with an authorization
// code. The node itx e2e (integrations-petshop.e2e.test.ts) proves everything
// AFTER the code (exchange → connection secret → worker refresh → api call);
// this proves the browser step that hands the code to a project's callback.
//
// Run: PETSHOP_BASE_URL=https://dummy-petshop.iterate-preview-3.com \
//        pnpm --dir apps/os playwright

import { expect, test } from "@playwright/test";

const REDIRECT_URI = "https://example.com/callback";

test("petshop OAuth consent: approve → redirect carries an authorization code", async ({
  page,
}) => {
  test.skip(!process.env.PETSHOP_BASE_URL, "set PETSHOP_BASE_URL to a deployed dummy-petshop");

  // Stub the redirect target so we capture the code off the URL without loading
  // a real third-party site.
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<h1>callback</h1>" }),
  );

  const authorize = new URL("/oauth/authorize", process.env.PETSHOP_BASE_URL);
  authorize.searchParams.set("client_id", "petshop-default");
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("state", "playwright-e2e");
  await page.goto(authorize.toString());

  // The consent page renders (not the approve=1 auto-lane).
  await expect(page.getByRole("heading", { name: /Pet Shop/ })).toBeVisible();
  await page.getByLabel("Your name").fill("Playwright User");
  await page.getByRole("button", { name: "Approve" }).click();

  // The form POST 302s back to the callback with ?code=…&state=….
  await page.waitForURL(/example\.com\/callback/);
  const landed = new URL(page.url());
  expect(landed.searchParams.get("code")).toBeTruthy();
  expect(landed.searchParams.get("state")).toBe("playwright-e2e");
});
