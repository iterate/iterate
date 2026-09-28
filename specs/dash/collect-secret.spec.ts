// The collection link's page (apps/dash/src/routes/collect-secret.$slug.tsx), end to end. The
// `dash-phone` project runs it again at a phone's width, with touch.
import { createHmac } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a collection link signs the person in, opens without the Dash's shell, saves the secret and says it is done", async ({
  page,
  helpers,
}) => {
  const dash = helpers.appOrigin("dash");
  // signed in to the issuer, not yet to the Dash: the link goes through consent and comes back
  await using fixture = await helpers.createFixture("collect-secret");
  const { url } = await fixture.itx.secrets.collectFromUser({
    path: "/secrets/exa",
    egress: { urls: ["https://mcp.exa.ai/mcp", "https://api.exa.ai"] },
    description:
      "Your Exa API key, from [Exa's API keys page](https://dashboard.exa.ai/api-keys). <img src=x onerror=alert(1)> [Not a link](javascript:alert(1))",
  });
  const link = new URL(url);
  expect({ origin: link.origin, pathname: link.pathname }).toEqual({
    origin: dash,
    pathname: `/collect-secret/${fixture.project.slug}`,
  });

  await page.goto(url);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  // noWaitAfter: Authorize posts and the issuer hands the browser back to the link; the heading
  // below waits for that
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  await page
    .getByRole("heading", { name: `Save a secret for ${fixture.project.slug}`, exact: true })
    .waitFor();
  // no shell: every client app's shell (packages/ui app-shell.tsx) has a project switcher, which a
  // phone's opens from the sidebar button
  expect(
    await page.getByRole("button", { name: /^(switch project|toggle sidebar)$/i }).count(),
  ).toBe(0);
  // the requester's words as markdown: its link opens in a new tab with its host beside it; raw
  // HTML and a script URL are not rendered
  const keysPage = page.getByRole("link", { name: "Exa's API keys page", exact: true });
  await keysPage.waitFor();
  expect({
    href: await keysPage.getAttribute("href"),
    target: await keysPage.getAttribute("target"),
    rel: await keysPage.getAttribute("rel"),
  }).toEqual({
    href: "https://dashboard.exa.ai/api-keys",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  await page.getByText("(dashboard.exa.ai)", { exact: true }).waitFor();
  // the page's logo is its only image: the description's raw <img> is not rendered
  expect(await page.locator("form img").count()).toBe(0);
  expect(await page.getByRole("link", { name: "Not a link" }).count()).toBe(0);
  await page.getByText("/secrets/exa", { exact: true }).waitFor();
  // the pin is origins, whatever path the requester named
  await page.getByText("https://mcp.exa.ai", { exact: true }).waitFor();
  await page.getByText("https://api.exa.ai", { exact: true }).waitFor();
  await page.getByText(`Signed in as ${fixture.email}`, { exact: true }).waitFor();

  const value = page.getByRole("textbox", { name: "Value", exact: true });
  const save = page.getByRole("button", { name: "Save", exact: true });
  // the caret is in the value already, so a paste lands without a click
  await value.and(page.locator(":focus")).waitFor();
  // touch targets a thumb can hit: 44 px or taller, the smallest Apple's and Google's guidelines allow
  expect((await value.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await save.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await value.fill("exa-test-key");
  await save.click();
  await page.getByText("Saved. You can close this tab.", { exact: true }).waitFor();
  expect(await fixture.itx.secrets.list()).toContainEqual(
    expect.objectContaining({
      path: "/secrets/exa",
      urls: ["https://mcp.exa.ai", "https://api.exa.ai"],
    }),
  );
});

test("a collection link that names the Secrets page opens the link's own page, which updates a secret the path already holds", async ({
  page,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("collect-secret-update");
  await fixture.itx.secrets.set("/secrets/stripe", "sk_test_old", {
    urls: ["https://api.stripe.com"],
  });
  const { url } = await fixture.itx.secrets.collectFromUser({
    path: "/secrets/stripe",
    egress: { urls: ["https://api.stripe.com"] },
  });

  await page.goto(
    `/projects/${fixture.project.slug}/secrets?collect=1&${new URL(url).searchParams}`,
  );
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  await page
    .getByRole("heading", { name: `Save a secret for ${fixture.project.slug}`, exact: true })
    .waitFor();
  await page.getByRole("textbox", { name: "Value", exact: true }).fill("sk_test_new");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.getByText("Saved. You can close this tab.", { exact: true }).waitFor();
});

test("a collection link with fields asks for each part and saves one JSON secret whose parts its fields name", async ({
  page,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("collect-secret-fields");
  const { url } = await fixture.itx.secrets.collectFromUser({
    path: "/secrets/provider-app",
    egress: { urls: ["https://provider.example"] },
    description: "Your OAuth app on Provider.",
    fields: [
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client secret" },
    ],
  });

  await page.goto(url);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  const clientId = page.getByRole("textbox", { name: "Client ID", exact: true });
  await clientId.waitFor();
  await clientId.and(page.locator(":focus")).waitFor();
  // one Value is not asked for: each part is its own field
  expect(await page.getByRole("textbox", { name: "Value", exact: true }).count()).toBe(0);
  await clientId.fill(" the-client-id ");
  await page.getByRole("textbox", { name: "Client secret", exact: true }).fill("the-client-secret");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved. You can close this tab.", { exact: true }).waitFor();

  // the parts are fields of one secret, each checked without reading it: an HMAC keyed with it
  const holds = async (field: string, value: string) =>
    fixture.itx.secrets.verifyHmac("/secrets/provider-app", {
      payload: "probe",
      signature: createHmac("sha256", value).update("probe").digest("hex"),
      field,
    });
  expect({
    clientId: await holds("clientId", "the-client-id"),
    clientSecret: await holds("clientSecret", "the-client-secret"),
  }).toEqual({ clientId: true, clientSecret: true });
});
