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

/** The page's password step: the email, the password (on the first step where the page shows it at
 *  once, else behind Continue), Continue. */
async function passwordStep(page: Page, origin: string, email: string, password?: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const field = page.getByRole("textbox", { name: "Password", exact: true });
  if (!(await field.isVisible()))
    await page.getByRole("button", { name: "Continue", exact: true }).click();
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
  // signed in with nowhere asked for: the page says so and points onward (to the dash, where the
  // deployment has one — /login.json says), and can switch account
  await passwordStep(page, origin, email);
  await page.getByText(`Signed in as ${email}.`).waitFor();
  const { dash } = (await (await page.request.get(`${origin}/login.json`)).json()) as {
    dash: string | null;
  };
  const onward = page.getByRole("link", { name: "Go to the dash", exact: true });
  expect(await onward.count()).toBe(dash ? 1 : 0);
  if (dash) expect(await onward.getAttribute("href")).toBe(dash);
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
  // signed out, whatever sign-ins the deployment offers next: /login.json names nobody
  await expect
    .poll(async () => {
      const state = (await (await other.request.get(`${origin}/login.json`)).json()) as {
        signedInAs: string | null;
      };
      return state.signedInAs;
    })
    .toBeNull();
  await other.close();
  // the page acts on its open socket; the platform refuses; the page leaves for sign-in, bound
  // for this very request
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(`ended-${stamp()}`);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.waitForURL(/\/login\?next=%2Foauth2%2Fauth%3F/);
  expect(errors).toEqual([]);
});

test("a consent page that cannot reach the platform says so instead of loading forever", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin, `offline-${stamp()}@example.com`);
  // the platform's socket drops before it answers anything
  await page.routeWebSocket(/\/api$/, (socket) => socket.close({ code: 1011, reason: "gone" }));
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: claudeClient,
    redirectUri: "http://127.0.0.1:1/callback",
    resources: [process.env.MCP_BASE_URL || `${origin}/mcp`],
    scopes: ["iterate"],
  });
  await page.goto(flow.url.href);
  await page.getByRole("alert").waitFor();
  expect(await page.getByText("Loading…", { exact: true }).count()).toBe(0);
  await page.getByRole("link", { name: "Try again", exact: true }).waitFor();
});

// These are presentation fixtures for deployment options, not proofs of Google/email identity.
// The password flow above and the OAuth browser test exercise the real server.
for (const variant of [
  { name: "password", password: true, emailSignIn: false, google: null },
  { name: "email code", password: false, emailSignIn: true, google: null },
  { name: "Google", password: false, emailSignIn: false, google: "/.auth/identity" },
  { name: "password and code", password: true, emailSignIn: true, google: null },
  { name: "password and Google", password: true, emailSignIn: false, google: "/.auth/identity" },
  { name: "code and Google", password: false, emailSignIn: true, google: "/.auth/identity" },
  { name: "all methods", password: true, emailSignIn: true, google: "/.auth/identity" },
  { name: "unconfigured", password: false, emailSignIn: false, google: null },
]) {
  test(`login layout: ${variant.name}`, async ({ page }) => {
    await page.route("**/login.json*", (route) =>
      route.fulfill({ json: { ...variant, next: "/login", email: "", signedInAs: null } }),
    );
    await page.goto("/login");
    await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
    await expect(page.getByLabel("Email", { exact: true })).toHaveCount(
      variant.password || variant.emailSignIn ? 1 : 0,
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(
      variant.password ? 1 : 0,
    );
    await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(
      variant.google ? 1 : 0,
    );
    if (!variant.password && !variant.emailSignIn && !variant.google)
      await page.getByText("Sign-in is not configured for this deployment.").waitFor();
    // Catch the original missing password styles and narrow-screen overflow.
    if (variant.password) {
      const email = await page.getByLabel("Email", { exact: true }).boundingBox();
      const password = await page.getByLabel("Password", { exact: true }).boundingBox();
      expect(password?.width).toBe(email?.width);
      expect(password?.height).toBe(email?.height);
      const submit = await page.getByRole("button", { name: "Sign in", exact: true }).boundingBox();
      expect(submit!.y - (password!.y + password!.height)).toBeGreaterThanOrEqual(16);
    }
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", page.viewportSize()!.width);
    await page.screenshot({ path: test.info().outputPath("login.png"), fullPage: true });
  });
}

test("email-code entry preserves the destination and supports retrying another email", async ({
  page,
}) => {
  await page.route("**/login.json*", (route) =>
    route.fulfill({
      json: {
        next: "/oauth2/auth?client_id=example",
        codeSentTo: "alex@example.com",
        error: "That code was not accepted. Try again.",
      },
    }),
  );
  const submissions: URLSearchParams[] = [];
  await page.route("**/login", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(new URLSearchParams(route.request().postData() || ""));
    await route.fulfill({ contentType: "text/html", body: "<h1>Submitted</h1>" });
  });
  await page.goto("/login");
  await page.getByRole("heading", { name: "Check your inbox" }).waitFor();
  await expect(page.getByRole("alert")).toContainText("That code was not accepted");
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("123456");
  await page.screenshot({ path: test.info().outputPath("code-entry.png"), fullPage: true });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Submitted" }).waitFor();
  expect(submissions[0]?.get("code")).toBe("123456");
  expect(submissions[0]?.get("next")).toBe("/oauth2/auth?client_id=example");
  await page.goto("/login");
  await page.getByRole("button", { name: "Use a different email" }).click();
  await page.getByRole("heading", { name: "Submitted" }).waitFor();
  expect(submissions[1]?.get("restart")).toBe("1");
  expect(submissions[1]?.get("next")).toBe("/oauth2/auth?client_id=example");
});
