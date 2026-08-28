// The secret-collection page: where a human hands over a credential an agent
// must never see. It is a MINI PAGE — the mobile app opens it in an in-app
// browser sheet — so it is spec'd at phone size, and its two jobs are to fit
// there and to tell the app when it is done.
//
// The link is stateless (apps/os/src/lib/collect-secret-link.ts builds it from
// nothing but search params), so the spec can hold one directly instead of
// driving an agent into minting it.

import { expect } from "@playwright/test";
import { buildCollectSecretUrl } from "../apps/os/src/lib/collect-secret-link.ts";
import { test } from "./test-support/test.ts";

const IPHONE_VIEWPORT = { height: 844, width: 390 };

test.use({ viewport: IPHONE_VIEWPORT });

test("a person provides a secret from a phone-sized sheet", async ({ baseURL, helpers, page }) => {
  await using fixture = await helpers.createFixture("collect-secret");

  await page.goto(
    buildCollectSecretUrl({
      baseUrl: baseURL!,
      projectSlug: fixture.project.slug,
      search: {
        egress: ["https://api.stripe.com"],
        path: "/secrets/integrations/stripe/api-key",
        description: "Stripe restricted key — Developers → API keys",
      },
    }),
  );

  await page.getByText("Provide a secret").waitFor();
  await page.getByText("Stripe restricted key — Developers → API keys").waitFor();
  await page.getByText("/secrets/integrations/stripe/api-key").waitFor();
  await page.getByText("https://api.stripe.com").waitFor();

  // Compact enough for the in-app browser sheet: the whole card inside
  // two-thirds of the phone screen, with the browser's own chrome to spare.
  const card = page.locator("[data-slot=card]");
  const box = await card.boundingBox();
  expect(box!.height).toBeLessThan((IPHONE_VIEWPORT.height * 2) / 3);

  // Pasting a credential on a phone is blind — the eye toggle is how you
  // check you pasted the key and not the clipboard's previous occupant.
  const hidden = page.locator('#secret-material[type="password"]');
  const shown = page.locator('#secret-material[type="text"]');
  await hidden.fill("sk_test_notarealkey");
  await page.getByRole("button", { name: "Show value" }).click();
  await shown.waitFor();
  await page.getByRole("button", { name: "Hide value" }).click();
  await hidden.waitFor();

  await page.getByRole("button", { name: "Save secret" }).click();
  await page.getByText("Secret saved").waitFor();

  // Stored write-only and already pinned: the page's promise, checked at the
  // source rather than taken from its own success copy.
  using admin = await fixture.connectAdmin();
  using project = admin.projects.get(fixture.project.id);
  const secret = await project.secrets.get("/secrets/integrations/stripe/api-key").__describe();
  expect(secret).toMatchObject({ hasMaterial: true, egress: { urls: ["https://api.stripe.com"] } });
});

test("a mini page hands the outcome back to the app that opened it", async ({
  baseURL,
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("collect-secret-return");

  const link = buildCollectSecretUrl({
    baseUrl: baseURL!,
    projectSlug: fixture.project.slug,
    search: { egress: ["https://api.stripe.com"], path: "/secrets/mini-page/api-key" },
  });
  // What apps/mobile/src/lib/mini-page.ts appends before handing the URL to
  // the in-app browser. Navigating to it is what makes the sheet close.
  await page.goto(`${link}&returnTo=${encodeURIComponent("iterate://mini-page")}`);

  await page.getByLabel("Value", { exact: true }).fill("sk_test_notarealkey");
  await page.getByRole("button", { name: "Save secret" }).click();

  // Chromium cannot follow `iterate://`, so the page's own auto-navigation is
  // invisible here — but the same URL is on the fallback link, which is what
  // a user taps when a browser sheet declines to dismiss itself. `no-notify`
  // because this link names no agent to tell.
  await page
    .locator('a[href="iterate://mini-page?path=%2Fsecrets%2Fmini-page%2Fapi-key&status=no-notify"]')
    .waitFor();
});
