// The secret-collection page: where a human hands over a credential an agent
// must never see. Phones render this request natively instead (see
// specs/mobile/collect-secret.spec.ts), so this page serves a link followed
// from a desktop, Slack or email — still spec'd at phone size, because that
// is often where such a link is read.
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
