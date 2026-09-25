// Signing in with Google, GitHub or Cloudflare keeps the token as the person's own connection, and
// the Dash's Integrations page lends it to a project. A preview's providers are the pet shop's fakes
// (apps/os/scripts/preview-{google,github,cloudflare}-app.ts): each asks which account on a picker
// page, as the real one does, then consents at once. A fake signs in addresses under the preview's
// test-link domain alone. The Dash is signed in to with its own scopes, `account` among them: the
// person's own connections are the account's.
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { Page } from "@playwright/test";
import { TEST_LINK_EMAIL_DOMAIN } from "../../apps/os/src/test-link.ts";
import { dashScopes } from "../../apps/dash/src/lib/scopes.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

for (const { provider, account } of [
  { provider: "Google", account: (email: string) => email },
  { provider: "GitHub", account: (_email: string, login: string) => login },
  { provider: "Cloudflare", account: (email: string) => email },
])
  test(`a person signs in with ${provider}, and the Dash lists the account as their own connection`, async ({
    page,
    helpers,
  }) => {
    helpers.appOrigin("dash");
    const { email, login, slug } = await personWithProject(`signin-${provider.toLowerCase()}`);
    await page.goto(
      `/.auth/login?${new URLSearchParams({ next: `/projects/${slug}/integrations`, scope: dashScopes.join(" ") })}`,
    );
    // the platform's sign-in page, then the provider's, then consent for the Dash
    await page
      .getByRole("link", { name: `Continue with ${provider}` })
      .click({ noWaitAfter: true });
    await pickAccount(page, { email, login: provider === "GitHub" ? login : undefined });
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
    await page
      .getByRole("list", { name: "Your connections" })
      .getByRole("listitem")
      .filter({ hasText: account(email, login) })
      .waitFor();
  });

test("a person lends the Google account they signed in with to their project, which lists it as lent", async ({
  page,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const { email, slug } = await personWithProject("lend-google");
  await page.goto(
    `/.auth/login?${new URLSearchParams({ next: `/projects/${slug}/integrations`, scope: dashScopes.join(" ") })}`,
  );
  await page.getByRole("link", { name: "Continue with Google" }).click({ noWaitAfter: true });
  await pickAccount(page, { email });
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  await page
    .getByRole("list", { name: "Your connections" })
    .getByRole("listitem")
    .filter({ hasText: email })
    .getByRole("button", { name: "Lend to this project" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Lend", exact: true }).click();
  await page
    .getByRole("region", { name: "Google" })
    .getByRole("listitem")
    .filter({ hasText: `Lent by ${email}` })
    .waitFor();
});

/** A fresh person under the preview's test-link domain who owns a fresh project (made as them by
 *  the operator): their address, and the GitHub login they pick. */
async function personWithProject(prefix: string) {
  const slug = uniqueFixtureSlug(prefix);
  const email = `${slug}@${TEST_LINK_EMAIL_DOMAIN}`;
  using operator = openOperatorSession();
  await operator.authenticate({ email }).projects.create({ project: slug }).whoami();
  return { email, login: slug, slug };
}

/** The provider's account picker: the person types which account, and goes on. */
async function pickAccount(page: Page, account: { email: string; login?: string }) {
  if (account.login) await page.getByRole("textbox", { name: "Username" }).fill(account.login);
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click({ noWaitAfter: true });
  // back through the platform to the Dash's consent: its page first, so the hydration waiter sees
  // the page it waits on before the next click
  await page.getByRole("heading", { name: "Select projects" }).waitFor();
}
