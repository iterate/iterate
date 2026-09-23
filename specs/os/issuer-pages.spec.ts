// Browser acceptance for the issuer's pages around the consent flow (auth.spec.ts drives that one
// end to end): the sign-in page's own states, the invalid-request page, and a consent page whose
// session ends underneath it. Like auth.spec.ts these run against the local worker or, with
// DEMO_BASE_URL, a deployment.
import { expect, type Page } from "@playwright/test";
import { authorizationCodeRequest } from "iterate/next/oauth";
import { spinnerWaiter } from "middlewright";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

test("the sign-in page refuses a wrong password in place, keeps the email, and tells a signed-in browser where to go", async ({
  page,
}) => {
  const email = `pages-${stamp()}@example.com`;
  await page.goto("/login");
  // a wrong password is refused where it was typed; the email is remembered, nobody is signed in
  await passwordStep(page, email, "not-the-password");
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("textbox", { name: "Email", exact: true }).inputValue()).toBe(email);
  expect(await page.getByText(`Signed in as ${email}.`).count()).toBe(0);
  // Signed in with nowhere asked for: the page says so and points onward.
  await passwordStep(page, email);
  await page.getByText(`Signed in as ${email}.`).waitFor();
  await page.goto("/");
  const dash = page.locator('a[href*="/.auth/connect?"]');
  const dashOrigin = (await dash.count())
    ? new URL((await dash.getAttribute("href"))!).origin
    : null;
  await page.goto("/login");
  await page.getByText(`Signed in as ${email}.`).waitFor();
  const onward = page.getByRole("link", { name: "Go to the dash", exact: true });
  if (dashOrigin) expect(await onward.getAttribute("href")).toBe(dashOrigin);
  else expect(await onward.count()).toBe(0);
  await page
    .getByRole("button", { name: "Switch account", exact: true })
    .click({ noWaitAfter: true });
  await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  expect(await page.getByText(`Signed in as ${email}.`).count()).toBe(0);
});

test("an invalid authorization request is a page with a way back, not a raw error", async ({
  page,
  helpers,
}) => {
  await helpers.createSession("invalid");
  await page.goto("/oauth2/auth?client_id=nope&response_type=code");
  await page.getByRole("heading", { name: "Invalid authorization request", exact: true }).waitFor();
  await page.getByText(/could not be accepted: .*client_id/).waitFor();
  await page.getByText("Nothing was granted.").waitFor();
  expect(
    await page.getByRole("link", { name: "Back to iterate", exact: true }).getAttribute("href"),
  ).toBe("/");
  // typed by hand, with nothing at all
  await page.goto("/oauth2/auth");
  await page.getByRole("heading", { name: "Invalid authorization request", exact: true }).waitFor();
  await page.getByText(/client_id is required/).waitFor();
});

test("a consent page whose session ends underneath it returns to sign-in", async ({
  page,
  context,
  baseURL,
  helpers,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await helpers.createSession("ended");
  const flow = await authorizationCodeRequest({
    issuer: new URL(baseURL!).origin,
    clientId: claudeClient,
    redirectUri: "http://127.0.0.1:1/callback",
    resources: [readOsPlaywrightAuthConfig().mcpBaseUrl],
    scopes: ["iterate"],
  });
  await page.goto(flow.url.href);
  await page.getByRole("heading", { name: "Create a project", exact: true }).waitFor();
  // the session ends elsewhere: another tab of the same browser switches account
  const other = await context.newPage();
  await other.goto("/login");
  await other
    .getByRole("button", { name: "Switch account", exact: true })
    .click({ noWaitAfter: true });
  // The server-rendered sign-in page now names nobody.
  await other.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  await other.close();
  // the page's next action is refused; it leaves for sign-in, bound for this very request
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(`ended-${stamp()}`);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  expect(page.url()).toMatch(/\/login\?next=%2Foauth2%2Fauth%3F/);
  expect(errors).toEqual([]);
});

test("a consent page whose action cannot reach the platform says so and can retry", async ({
  page,
  baseURL,
  helpers,
}) => {
  await helpers.createSession("offline");
  const flow = await authorizationCodeRequest({
    issuer: new URL(baseURL!).origin,
    clientId: claudeClient,
    redirectUri: "http://127.0.0.1:1/callback",
    resources: [readOsPlaywrightAuthConfig().mcpBaseUrl],
    scopes: ["iterate"],
  });
  await page.goto(flow.url.href);
  await page.getByRole("heading", { name: "Create a project", exact: true }).waitFor();
  // the platform drops the project-creating call
  await page.route("**/_serverFn/**", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(`offline-${stamp()}`);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("alert").waitFor();
  // the refusal leaves the action ready to try again
  await page
    .getByRole("button", { name: "Review permissions", exact: true, disabled: false })
    .waitFor();
  await page.unroute("**/_serverFn/**");
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("heading", { name: "Review permissions", exact: true }).waitFor();
});

test("the sign-in page renders its state in HTML without a JSON round trip", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto("/login");
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  await page.getByLabel("Email", { exact: true }).waitFor();
  expect(requests).not.toContain("/login.json");
  expect(await page.getByText("Loading…", { exact: true }).count()).toBe(0);
  await page.screenshot({ path: test.info().outputPath("login.png"), fullPage: true });
});

test("email-code sign-in keeps the destination after a rejected address", async ({ page }) => {
  const next = `/oauth2/auth?client_id=example-${stamp()}`;
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const sendCode = page.getByRole("button", { name: "Send me a code", exact: true });
  test.skip((await sendCode.count()) === 0, "email-code sign-in is not configured");
  const providers = await page.getByRole("link", { name: /^Continue with / }).count();
  const email = `code-${stamp()}@example.com`;
  await page.getByLabel("Email", { exact: true }).fill(email);
  await sendCode.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /^Enter an email that can receive mail\.$/ })
    .waitFor();
  expect(await page.getByLabel("Email", { exact: true }).inputValue()).toBe(email);
  // A hidden input is never visible, and the spinner-waiter judges readiness by visibility:
  // Playwright's own wait for it to attach is the right one here.
  const destination = await spinnerWaiter.settings.run({ disabled: true }, () =>
    page.locator('form:has([name="email"]) [name="next"]').inputValue(),
  );
  expect(destination).toBe(next);
  expect(await page.getByRole("link", { name: /^Continue with / }).count()).toBe(providers);
});

// Real DCR and consent, with only the external logo response controlled by the browser.
for (const loads of [true, false]) {
  test(`consent client branding: ${loads ? "logo and domain" : "broken logo keeps initials"}`, async ({
    page,
    baseURL,
    helpers,
  }) => {
    const logoUri = "https://images.example/app.svg";
    const logoRequests: { referer?: string }[] = [];
    await page.route(logoUri, async (route) => {
      logoRequests.push({ referer: route.request().headers().referer });
      await route.fulfill({
        contentType: "image/svg+xml",
        body: loads
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 8 38 26 56 32 38 38 32 56 26 38 8 32 26 26Z" fill="#171717"/></svg>'
          : "not an image",
      });
    });
    const registration = await page.request.post("/oauth2/register", {
      data: {
        client_name: "Example App",
        client_uri: "https://example.com/about",
        logo_uri: logoUri,
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      // A page.request call inherits the tight actionTimeout, but dynamic client registration is
      // fixture setup over HTTP. timeout: no loading UI exists for the spinner-waiter
      timeout: 15_000,
    });
    expect(registration.status()).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const flow = await authorizationCodeRequest({
      issuer: new URL(baseURL!).origin,
      clientId,
      redirectUri: "http://127.0.0.1/callback",
      resources: [readOsPlaywrightAuthConfig().mcpBaseUrl],
    });
    await helpers.createSession("branding");
    await page.goto(flow.url.href);
    await page.getByRole("heading", { name: "Example App wants to access your account" }).waitFor();
    await page.getByText("example.com", { exact: true }).waitFor();
    // A blocked CSP would never request the logo; a referrer would leak the authorization URL.
    await expect.poll(() => logoRequests).toEqual([{ referer: undefined }]);
    const tile = page.getByTestId("client-logo");
    if (loads) await expect.poll(() => naturalWidth(tile.locator("img"))).toBe(64);
    else await tile.filter({ hasText: /^EX$/ }).waitFor();
    await page
      .getByRole("textbox", { name: "Project slug", exact: true })
      .fill(`branding-${stamp()}`);
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page.getByRole("heading", { name: "Review permissions", exact: true }).waitFor();
    await page.getByText("example.com", { exact: true }).waitFor();
    if (loads) await expect.poll(() => naturalWidth(tile.locator("img"))).toBe(64);
    else await tile.filter({ hasText: /^EX$/ }).waitFor();
    await page.getByRole("button", { name: "Edit selected projects", exact: true }).click();
    await page.getByRole("heading", { name: "Select projects", exact: true }).waitFor();
    expect(await page.locator("body").evaluate((body) => body.scrollWidth)).toBe(
      page.viewportSize()!.width,
    );
    await page.screenshot({ path: test.info().outputPath("client-branding.png"), fullPage: true });
  });
}

/** Password is the alternate method when email-code sign-in is configured. */
async function passwordStep(page: Page, email: string, password?: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const field = page.getByLabel("Password", { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole("button", { name: "Use password instead", exact: true }).click();
  await field.fill(password || readOsPlaywrightAuthConfig().loginPassword);
  // noWaitAfter: the post navigates; the next locator waits for it (the spinner-waiter counts a
  // navigation in flight as loading), not the click's tight action timeout
  await page.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
}

/** A loaded image's intrinsic width; 0 until it decodes, and for one that failed to. */
function naturalWidth(image: ReturnType<Page["locator"]>) {
  return image.evaluate((element: HTMLImageElement) => element.naturalWidth);
}
