// The Dash's Integrations page: a project connects Slack, Google and GitHub through iterate's apps,
// sees each connection listed, and disconnects it. A preview's iterate apps are the pet shop's fakes
// (apps/os/scripts/preview-{slack,google,github}-app.ts): their pages send the browser straight back
// through the platform's callback, which finishes the connection; GitHub's install page is where a
// person picks the account, which the spec does by naming an installation it registered.
import { createPublicKey } from "node:crypto";
import {
  PREVIEW_GITHUB_APP,
  previewGithubAppPrivateKey,
} from "../../apps/os/scripts/preview-github-app.ts";
import {
  petshopBaseUrl,
  petshopRegisterGithubInstallation,
} from "../../apps/os/e2e/support/petshop.ts";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

test("a project connects Slack through iterate's app, lists the workspace, and disconnects it", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using _fixture = await helpers.createFixture("integrations-slack", { app: baseURL });
  await page.getByRole("link", { name: "Integrations", exact: true }).click();
  const slack = page.getByRole("region", { name: "Slack" });
  await slack.getByText("No workspaces connected.").waitFor();
  // noWaitAfter: the click leaves for the provider and comes back through the platform's callback;
  // the next locator waits for that (the spinner-waiter counts a navigation in flight as loading)
  await slack
    .getByRole("button", { name: "Connect Slack", exact: true })
    .click({ noWaitAfter: true });
  // Slack's consent, then back here, where the workspace is listed
  const workspace = slack.getByRole("listitem").filter({ hasText: "Connected · iterate's app" });
  await workspace.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await slack.getByText("No workspaces connected.").waitFor();
});

test("a project connects Google through iterate's client, lists the account, and disconnects it", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using _fixture = await helpers.createFixture("integrations-google", { app: baseURL });
  await page.getByRole("link", { name: "Integrations", exact: true }).click();
  const google = page.getByRole("region", { name: "Google" });
  await google
    .getByRole("button", { name: "Connect Google", exact: true })
    .click({ noWaitAfter: true });
  // Google's consent, then back here: the account is the address Google names
  const account = google.getByRole("listitem").filter({ hasText: "Connected · iterate's app" });
  await account.getByText("@").waitFor();
  await account.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await google.getByText("No accounts connected.").waitFor();
});

test("a project installs iterate's GitHub App, lists the account it is installed on, and disconnects it", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const { osBaseUrl } = readOsPlaywrightAuthConfig();
  const installation = {
    installationId: String(Math.floor(1e9 + Math.random() * 8e9)),
    accountLogin: `org-${crypto.randomUUID().slice(0, 8)}`,
    // the fake's user unless the install page names another, an admin of the organization
    adminLogin: "petshop-user",
  };
  await petshopRegisterGithubInstallation({
    ...installation,
    appId: PREVIEW_GITHUB_APP.appId,
    appSlug: PREVIEW_GITHUB_APP.appSlug,
    // the public half of the preview's throwaway key (Doppler os/preview), what the shop verifies
    publicKeyPem: createPublicKey(previewGithubAppPrivateKey())
      .export({ type: "spki", format: "pem" })
      .toString(),
    webhookSecret: PREVIEW_GITHUB_APP.webhookSecret,
    callbackUrl: `${osBaseUrl}/api/integrations/github/callback`,
  });
  // on GitHub's install page a person picks the account; here, the installation registered above
  await page.route(`${petshopBaseUrl()}/apps/*/installations/new*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("installation_id", installation.installationId);
    return route.continue({ url: url.href });
  });
  await using _fixture = await helpers.createFixture("integrations-github", { app: baseURL });
  await page.getByRole("link", { name: "Integrations", exact: true }).click();
  const github = page.getByRole("region", { name: "GitHub" });
  await github
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click({ noWaitAfter: true });
  // install (GitHub asks the person to authorize the App on the same page), then back here
  const account = github.getByRole("listitem").filter({ hasText: installation.accountLogin });
  await account.getByText("Connected · iterate's app").waitFor();
  await account.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await github.getByText("No accounts connected.").waitFor();
});

test("a project brings its own Slack app: the sheet gives the URLs to paste into Slack's console, keeps the app's credentials in the connection's secret, and sends the browser to the app's consent", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  // the project's own app is Slack's real one, so its consent page is stood in for here
  await page.route("https://slack.com/oauth/v2/authorize*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Slack asks you to install ${new URL(route.request().url()).searchParams.get("client_id")}</h1>`,
    }),
  );
  await using _fixture = await helpers.createFixture("integrations-own-slack", { app: baseURL });
  await page.getByRole("link", { name: "Integrations", exact: true }).click();
  await page
    .getByRole("region", { name: "Slack" })
    .getByRole("button", { name: "Use your own app", exact: true })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByText("/api/integrations/slack/callback").waitFor();
  await sheet.getByText("/api/integrations/slack/interactivity-webhook/").waitFor();
  await sheet.getByRole("textbox", { name: "Client ID" }).fill("own-slack-client");
  await sheet.getByRole("textbox", { name: "Client Secret" }).fill("own-slack-secret");
  await sheet.getByRole("textbox", { name: "Signing Secret" }).fill("own-signing-secret");
  await sheet
    .getByRole("button", { name: "Continue to Slack", exact: true })
    .click({ noWaitAfter: true });
  await page.getByRole("heading", { name: "Slack asks you to install own-slack-client" }).waitFor();
});
