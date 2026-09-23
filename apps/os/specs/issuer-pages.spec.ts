// Browser acceptance for the issuer's pages around the consent flow (auth.spec.ts drives that one
// end to end): the sign-in page's own states, the invalid-request page, and a consent page whose
// session ends underneath it. Like auth.spec.ts these run against the local worker or, with
// DEMO_BASE_URL, a deployment.
import { expect, type Page } from "@playwright/test";
import { authorizationCodeRequest } from "iterate/next/oauth";
import { test } from "./test.ts";

const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
/** The deployment's sign-in password (src/app-config.ts `login.password`): the local worker's
 *  (scripts/dev.ts), else the run's LOGIN_PASSWORD. */
const loginPassword = (origin: string) => {
  const password =
    process.env.LOGIN_PASSWORD || (new URL(origin).hostname === "localhost" && "dev");
  if (!password) throw new Error("LOGIN_PASSWORD is required to sign in to a deployed worker");
  return password;
};

/** Password is the alternate method when email-code sign-in is configured. */
async function passwordStep(page: Page, origin: string, email: string, password?: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const field = page.getByLabel("Password", { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole("button", { name: "Use password instead", exact: true }).click();
  await field.fill(password || loginPassword(origin));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Sign in the way auth.spec.ts does — the page's password step — and land on `next`. */
async function signIn(page: Page, origin: string, email: string, next = "/") {
  await page.goto(`${origin}/login?next=${encodeURIComponent(next)}`);
  await passwordStep(page, origin, email);
  await page.waitForURL((url) => url.pathname !== "/login");
}

test("the sign-in page refuses a wrong password in place, keeps the email, and tells a signed-in browser where to go", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const email = `pages-${stamp()}@example.com`;
  await page.goto(`${origin}/login`);
  // a wrong password is refused where it was typed; the email is remembered, nobody is signed in
  await passwordStep(page, origin, email, "not-the-password");
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("textbox", { name: "Email", exact: true }).inputValue()).toBe(email);
  expect(await page.getByText(`Signed in as ${email}.`).count()).toBe(0);
  // Signed in with nowhere asked for: the page says so and points onward.
  await passwordStep(page, origin, email);
  await page.getByText(`Signed in as ${email}.`).waitFor();
  await page.goto(origin);
  const dash = page.locator('a[href*="/.auth/connect?"]');
  const dashOrigin = (await dash.count())
    ? new URL((await dash.getAttribute("href"))!).origin
    : null;
  await page.goto(`${origin}/login`);
  const onward = page.getByRole("link", { name: "Go to the dash", exact: true });
  await expect(onward).toHaveCount(dashOrigin ? 1 : 0);
  if (dashOrigin) await expect(onward).toHaveAttribute("href", dashOrigin);
  await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  expect(await page.getByText(`Signed in as ${email}.`).count()).toBe(0);
});

test("an invalid authorization request is a page with a way back, not a raw error", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin, `invalid-${stamp()}@example.com`);
  await page.goto(`${origin}/oauth2/auth?client_id=nope&response_type=code`);
  await page.getByRole("heading", { name: "Invalid authorization request", exact: true }).waitFor();
  await page.getByText(/could not be accepted: .*client_id/).waitFor();
  await page.getByText("Nothing was granted.").waitFor();
  expect(
    await page.getByRole("link", { name: "Back to iterate", exact: true }).getAttribute("href"),
  ).toBe("/");
  // typed by hand, with nothing at all
  await page.goto(`${origin}/oauth2/auth`);
  await page.getByRole("heading", { name: "Invalid authorization request", exact: true }).waitFor();
  await page.getByText(/client_id is required/).waitFor();
});

test("a consent page whose session ends underneath it returns to sign-in", async ({
  page,
  context,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, origin, `ended-${stamp()}@example.com`);
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: claudeClient,
    redirectUri: "http://127.0.0.1:1/callback",
    resources: [process.env.MCP_BASE_URL || `${origin}/mcp`],
    scopes: ["iterate"],
  });
  await page.goto(flow.url.href);
  await page.getByRole("heading", { name: "Create a project", exact: true }).waitFor();
  // the session ends elsewhere: another tab of the same browser switches account
  const other = await context.newPage();
  await other.goto(`${origin}/login`);
  await other.getByRole("button", { name: "Switch account", exact: true }).click();
  // The server-rendered sign-in page now names nobody.
  await other.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  await other.close();
  // the page's next action is refused; it leaves for sign-in, bound for this very request
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(`ended-${stamp()}`);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.waitForURL(/\/login\?next=%2Foauth2%2Fauth%3F/);
  expect(errors).toEqual([]);
});

test("a consent page whose action cannot reach the platform says so and can retry", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin, `offline-${stamp()}@example.com`);
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: claudeClient,
    redirectUri: "http://127.0.0.1:1/callback",
    resources: [process.env.MCP_BASE_URL || `${origin}/mcp`],
    scopes: ["iterate"],
  });
  await page.goto(flow.url.href);
  await page.getByRole("heading", { name: "Create a project", exact: true }).waitFor();
  // the platform drops the project-creating call
  await page.route("**/_serverFn/**", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(`offline-${stamp()}`);
  const review = page.getByRole("button", { name: "Review permissions", exact: true });
  await review.click();
  await page.getByRole("alert").waitFor();
  await expect(review).toBeEnabled();
  await page.unroute("**/_serverFn/**");
  await review.click();
  await page.getByRole("heading", { name: "Review permissions", exact: true }).waitFor();
});

test("the sign-in page renders its state in HTML without a JSON round trip", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto("/login");
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  await page.getByLabel("Email", { exact: true }).waitFor();
  expect(requests).not.toContain("/login.json");
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("login.png"), fullPage: true });
});

test("email-code sign-in keeps the destination after a rejected address", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const next = `/oauth2/auth?client_id=example-${stamp()}`;
  await page.goto(`${origin}/login?next=${encodeURIComponent(next)}`);
  const sendCode = page.getByRole("button", { name: "Send me a code", exact: true });
  test.skip((await sendCode.count()) === 0, "email-code sign-in is not configured");
  const providers = await page.getByRole("link", { name: /^Continue with / }).count();
  const email = `code-${stamp()}@example.com`;
  await page.getByLabel("Email", { exact: true }).fill(email);
  await sendCode.click();
  await expect(page.getByRole("alert")).toHaveText("Enter an email that can receive mail.");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);
  await expect(page.locator('form:has([name="email"]) [name="next"]')).toHaveValue(next);
  await expect(page.getByRole("link", { name: /^Continue with / })).toHaveCount(providers);
});

// Real DCR and consent, with only the external logo response controlled by the browser.
for (const loads of [true, false]) {
  test(`consent client branding: ${loads ? "logo and domain" : "broken logo keeps initials"}`, async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
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
    const registration = await page.request.post(`${origin}/oauth2/register`, {
      data: {
        client_name: "Example App",
        client_uri: "https://example.com/about",
        logo_uri: logoUri,
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    });
    expect(registration.status()).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const flow = await authorizationCodeRequest({
      issuer: origin,
      clientId,
      redirectUri: "http://127.0.0.1/callback",
      resources: [process.env.MCP_BASE_URL || `${origin}/mcp`],
    });
    await signIn(
      page,
      origin,
      `branding-${stamp()}@example.com`,
      flow.url.pathname + flow.url.search,
    );
    await page.getByRole("heading", { name: "Example App wants to access your account" }).waitFor();
    await page.getByText("example.com", { exact: true }).waitFor();
    // A blocked CSP would never request the logo; a referrer would leak the authorization URL.
    await expect.poll(() => logoRequests).toEqual([{ referer: undefined }]);
    const tile = page.getByTestId("client-logo");
    if (loads) await expect(tile.locator("img")).toHaveJSProperty("naturalWidth", 64);
    else await expect(tile).toHaveText("EX");
    await page
      .getByRole("textbox", { name: "Project slug", exact: true })
      .fill(`branding-${stamp()}`);
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page.getByRole("heading", { name: "Review permissions", exact: true }).waitFor();
    await page.getByText("example.com", { exact: true }).waitFor();
    if (loads) await expect(tile.locator("img")).toHaveJSProperty("naturalWidth", 64);
    else await expect(tile).toHaveText("EX");
    await page.getByRole("button", { name: "Edit selected projects", exact: true }).click();
    await page.getByRole("heading", { name: "Select projects", exact: true }).waitFor();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", page.viewportSize()!.width);
    await page.screenshot({ path: test.info().outputPath("client-branding.png"), fullPage: true });
  });
}
