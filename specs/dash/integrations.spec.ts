// The Dash's Integrations page: a project connects Slack, Google and GitHub through iterate's apps —
// Connect opens a sheet, whose "another account" goes through iterate's app — sees each connection
// listed, and disconnects it. A preview's iterate apps are the pet shop's fakes
// (apps/os/scripts/preview-{slack,google,github}-app.ts): their pages send the browser straight back
// through the platform's callback, which finishes the connection; GitHub's install page is where a
// person picks the account, which the spec does by naming an installation it registered (and Slack's
// consent page the workspace, by naming a team). An installation or a workspace another project
// holds comes back as an offer to move it, which one button takes.
import { createPublicKey } from "node:crypto";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  PREVIEW_GITHUB_APP,
  previewGithubAppPrivateKey,
} from "../../apps/os/scripts/preview-github-app.ts";
import {
  petshopBaseUrl,
  petshopRegisterGithubInstallation,
} from "../../apps/os/e2e/support/petshop.ts";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { openOperatorSession } from "../test-support/operator.ts";
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
  await slack.getByText("Not connected", { exact: true }).waitFor();
  // noWaitAfter: the click leaves for the provider and comes back through the platform's callback;
  // the next locator waits for that (the spinner-waiter counts a navigation in flight as loading)
  await slack.getByRole("button", { name: "Connect Slack", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect a Slack workspace", exact: true })
    .click({ noWaitAfter: true });
  // Slack's consent, then back here, where the workspace is listed and the row offers another
  const workspace = slack.getByRole("listitem");
  await slack
    .getByRole("button", { name: "Connect another Slack workspace", exact: true })
    .waitFor();
  await workspace.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await slack.getByText("Not connected", { exact: true }).waitFor();
});

test("another service: the sheet gives the MCP command and a prompt for the person's agent that names the service", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("integrations-other", { app: baseURL });
  await page.getByRole("link", { name: "Integrations", exact: true }).click();
  await page.getByRole("button", { name: "Connect another service", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByText("claude mcp add --transport http iterate", { exact: false }).waitFor();
  await sheet.getByRole("textbox", { name: "2. The service" }).fill("Linear");
  await sheet
    .getByText(`Connect Linear to my iterate project "${fixture.project.slug}"`, { exact: false })
    .waitFor();
  await sheet.getByText('path: "/secrets/linear"', { exact: false }).waitFor();
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
  await google.getByRole("button", { name: "Connect Google", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect a Google account", exact: true })
    .click({ noWaitAfter: true });
  // Google's consent, then back here: the account is the address Google names
  const account = google.getByRole("listitem").filter({ hasText: "@" });
  await account.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await google.getByText("Not connected", { exact: true }).waitFor();
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
  await github.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Install on a GitHub account", exact: true })
    .click({ noWaitAfter: true });
  // install (GitHub asks the person to authorize the App on the same page), then back here
  const account = github.getByRole("listitem").filter({ hasText: installation.accountLogin });
  await account.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await github.getByText("Not connected", { exact: true }).waitFor();
});

test("a person moves a GitHub installation another of their projects holds: the prompt says what the other project loses, and one button moves it", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const { osBaseUrl } = readOsPlaywrightAuthConfig();
  const installation = {
    installationId: String(Math.floor(1e9 + Math.random() * 8e9)),
    accountLogin: `org-${crypto.randomUUID().slice(0, 8)}`,
    adminLogin: "petshop-user",
  };
  await petshopRegisterGithubInstallation({
    ...installation,
    appId: PREVIEW_GITHUB_APP.appId,
    appSlug: PREVIEW_GITHUB_APP.appSlug,
    publicKeyPem: createPublicKey(previewGithubAppPrivateKey())
      .export({ type: "spki", format: "pem" })
      .toString(),
    webhookSecret: PREVIEW_GITHUB_APP.webhookSecret,
    callbackUrl: `${osBaseUrl}/api/integrations/github/callback`,
  });
  await page.route(`${petshopBaseUrl()}/apps/*/installations/new*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("installation_id", installation.installationId);
    return route.continue({ url: url.href });
  });
  await using fixture = await helpers.createFixture("integrations-move", { app: baseURL });
  // a second project of the same person, which connects the installation first
  const holderSlug = uniqueFixtureSlug("integrations-held");
  {
    using operator = openOperatorSession();
    await operator
      .authenticate({ email: fixture.email })
      .projects.create({ project: holderSlug })
      .whoami();
  }
  const installThrough = async (slug: string) => {
    await page.goto(`/projects/${slug}/integrations`);
    await page
      .getByRole("region", { name: "GitHub" })
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Install on a GitHub account", exact: true })
      .click({ noWaitAfter: true });
  };
  await installThrough(holderSlug);
  await page
    .getByRole("region", { name: "GitHub" })
    .getByRole("listitem")
    .filter({ hasText: installation.accountLogin })
    .waitFor();
  // now the fixture's own project: GitHub knows the person administers it, and the platform offers the move
  await installThrough(fixture.project.slug);
  const prompt = page.getByRole("dialog");
  await prompt
    .getByText(`${installation.accountLogin} is connected to ${holderSlug}.`, { exact: false })
    .waitFor();
  await prompt.getByRole("button", { name: "Move here", exact: true }).click();
  await page
    .getByRole("region", { name: "GitHub" })
    .getByRole("listitem")
    .filter({ hasText: installation.accountLogin })
    .waitFor();
  await page.goto(`/projects/${holderSlug}/integrations`);
  await page
    .getByRole("region", { name: "GitHub" })
    .getByText("Not connected", { exact: true })
    .waitFor();
});

test("a person moves a Slack workspace another of their projects holds: installing iterate's app into it again offers the move, and one button moves it", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  const team = `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const workspace = `Pet Shop ${team}`;
  // on Slack's consent page a person picks the workspace; here, the same one both times
  await page.route(`${petshopBaseUrl()}/oauth/v2/authorize*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("team", team);
    return route.continue({ url: url.href });
  });
  await using fixture = await helpers.createFixture("integrations-slack-move", { app: baseURL });
  // a second project of the same person, which connects the workspace first
  const holderSlug = uniqueFixtureSlug("integrations-slack-held");
  {
    using operator = openOperatorSession();
    await operator
      .authenticate({ email: fixture.email })
      .projects.create({ project: holderSlug })
      .whoami();
  }
  const installThrough = async (slug: string) => {
    await page.goto(`/projects/${slug}/integrations`);
    await page
      .getByRole("region", { name: "Slack" })
      .getByRole("button", { name: "Connect Slack", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Connect a Slack workspace", exact: true })
      .click({ noWaitAfter: true });
  };
  await installThrough(holderSlug);
  await page
    .getByRole("region", { name: "Slack" })
    .getByRole("listitem")
    .filter({ hasText: workspace })
    .waitFor();
  // now the fixture's own project: Slack let the person install into the workspace, and the
  // platform offers the move
  await installThrough(fixture.project.slug);
  const prompt = page.getByRole("dialog");
  await prompt.getByText(`${workspace} is connected to ${holderSlug}.`, { exact: false }).waitFor();
  await prompt
    .getByText("stops that project's Slack access and events", { exact: false })
    .waitFor();
  await prompt.getByRole("button", { name: "Move here", exact: true }).click();
  await page
    .getByRole("region", { name: "Slack" })
    .getByRole("listitem")
    .filter({ hasText: workspace })
    .waitFor();
  await page.goto(`/projects/${holderSlug}/integrations`);
  await page
    .getByRole("region", { name: "Slack" })
    .getByText("Not connected", { exact: true })
    .waitFor();
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
    .getByRole("button", { name: "Connect Slack", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Use your own Slack app", exact: true })
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
