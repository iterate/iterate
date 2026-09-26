// Signing in with Google, GitHub or Cloudflare keeps the token as the person's own account, listed
// under "Connected accounts" on /sessions, and a project's Integrations page connects it: Connect
// Google offers the accounts the person already has, and one click connects one — no provider
// round-trip when the sign-in already granted what the project asks for. Disconnecting it from the
// project leaves it the person's. A preview's providers are the pet shop's fakes
// (apps/os/scripts/preview-{google,github,cloudflare}-app.ts): each asks which account on a picker
// page, as the real one does, then consents at once. A fake signs in addresses under the preview's
// test-link domain alone. The Dash is signed in to with its own scopes, `account` among them: the
// person's own connections are the account's.
import { createPublicKey } from "node:crypto";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { Page } from "@playwright/test";
import {
  petshopBaseUrl,
  petshopRegisterGithubInstallation,
} from "../../apps/os/e2e/support/petshop.ts";
import {
  PREVIEW_GITHUB_APP,
  previewGithubAppPrivateKey,
} from "../../apps/os/scripts/preview-github-app.ts";
import { TEST_LINK_EMAIL_DOMAIN } from "../../apps/os/src/test-link.ts";
import { dashScopes } from "../../apps/dash/src/lib/scopes.ts";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

for (const { provider, account } of [
  { provider: "Google", account: (email: string) => email },
  { provider: "GitHub", account: (_email: string, login: string) => login },
  { provider: "Cloudflare", account: (email: string) => email },
])
  test(`a person signs in with ${provider}, and the Dash lists the account among their connected accounts`, async ({
    page,
    helpers,
  }) => {
    helpers.appOrigin("dash");
    const { email, login } = await personWithProject(`signin-${provider.toLowerCase()}`);
    await page.goto(
      `/.auth/login?${new URLSearchParams({ next: "/sessions", scope: dashScopes.join(" ") })}`,
    );
    // the platform's sign-in page, then the provider's, then consent for the Dash
    await page
      .getByRole("link", { name: `Continue with ${provider}` })
      .click({ noWaitAfter: true });
    await pickAccount(page, { email, login: provider === "GitHub" ? login : undefined });
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
    await page
      .getByRole("list", { name: "Connected accounts" })
      .getByRole("listitem")
      .filter({ hasText: account(email, login) })
      .waitFor();
  });

test("a person connects the Google account they signed in with to their project in one click, and disconnecting it there leaves it theirs", async ({
  page,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const { email, slug } = await personWithProject("connect-google");
  await page.goto(
    `/.auth/login?${new URLSearchParams({ next: `/projects/${slug}/integrations`, scope: dashScopes.join(" ") })}`,
  );
  await page.getByRole("link", { name: "Continue with Google" }).click({ noWaitAfter: true });
  await pickAccount(page, { email });
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  const google = page.getByRole("region", { name: "Google" });
  await google.getByRole("button", { name: "Connect Google", exact: true }).click();
  // the sheet offers the account the person signed in with first, ready as it is
  const yours = page
    .getByRole("dialog")
    .getByRole("list", { name: "Your accounts" })
    .getByRole("listitem")
    .filter({ hasText: email });
  await yours.getByRole("button", { name: `Use ${email}`, exact: true }).click();
  const connected = google.getByRole("listitem").filter({ hasText: email });
  await connected.getByText("Yours · Gmail, Calendar, Docs, Drive").waitFor();
  await connected.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await google.getByText("Not connected", { exact: true }).waitFor();
  // still the person's own, on their account page
  await page.goto("/sessions");
  await page
    .getByRole("list", { name: "Connected accounts" })
    .getByRole("listitem")
    .filter({ hasText: email })
    .waitFor();
});

test("a person who signed in with GitHub connects an organization iterate's app is already installed on, straight from the list, without GitHub's configure page", async ({
  page,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const { osBaseUrl } = readOsPlaywrightAuthConfig();
  const { email, login, slug } = await personWithProject("connect-installed");
  const accountLogin = `org-${crypto.randomUUID().slice(0, 8)}`;
  await petshopRegisterGithubInstallation({
    installationId: String(Math.floor(1e9 + Math.random() * 8e9)),
    accountLogin,
    adminLogin: login,
    appId: PREVIEW_GITHUB_APP.appId,
    appSlug: PREVIEW_GITHUB_APP.appSlug,
    publicKeyPem: createPublicKey(previewGithubAppPrivateKey())
      .export({ type: "spki", format: "pem" })
      .toString(),
    webhookSecret: PREVIEW_GITHUB_APP.webhookSecret,
    callbackUrl: `${osBaseUrl}/api/integrations/github/callback`,
  });
  await page.goto(
    `/.auth/login?${new URLSearchParams({ next: `/projects/${slug}/integrations`, scope: dashScopes.join(" ") })}`,
  );
  await page.getByRole("link", { name: "Continue with GitHub" }).click({ noWaitAfter: true });
  await pickAccount(page, { email, login });
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  // GitHub's authorize page answers for the person signed in there, as the real one does
  await page.route(`${petshopBaseUrl()}/login/oauth/authorize*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("login", login);
    return route.continue({ url: url.href });
  });
  const github = page.getByRole("region", { name: "GitHub" });
  await github.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("list", { name: "Where iterate's app is installed" })
    .getByRole("button", { name: `Connect ${accountLogin}`, exact: true })
    .click({ noWaitAfter: true });
  await github.getByRole("listitem").filter({ hasText: accountLogin }).waitFor();
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
