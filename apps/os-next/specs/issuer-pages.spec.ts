// Browser acceptance for the issuer's pages around the consent flow (auth.spec.ts drives that one
// end to end): the sign-in page's own states, the invalid-request page, and a consent page whose
// session ends underneath it. Like auth.spec.ts these run against the local worker or, with
// DEMO_BASE_URL, a deployment.
import { expect, test, type Page } from "@playwright/test";
import { authorizationCodeRequest } from "iterate/next/oauth";

const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const isLocal = (origin: string) => new URL(origin).hostname === "localhost";
/** The code step accepts 424242 locally and on a deployment that says so. */
const acceptsTestCode = (origin: string) =>
  isLocal(origin) || process.env.TEST_EMAIL_LOGIN === "true";
const adminSecret = (origin: string) => {
  const secret = process.env.ADMIN_API_SECRET || (isLocal(origin) && "dev-admin-api-secret");
  if (!secret) throw new Error("ADMIN_API_SECRET is required for the deployed identity fixture");
  return secret;
};

/** Sign in the way auth.spec.ts does: the test code where the deployment accepts one, else the
 *  administrator's identity fixture — and land on `next`. */
async function signIn(page: Page, origin: string, email: string, next = "/") {
  await page.goto(`${origin}/login?next=${encodeURIComponent(next)}`);
  if (acceptsTestCode(origin)) {
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("textbox", { name: "Code", exact: true }).fill("424242");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // the sign-in lands on `next` by way of the session's callback: wait for the destination
    // itself, not the first URL that is no longer /login (that one may still be mid-callback)
    await page.waitForURL(new URL(next, origin).href);
    return;
  }
  await page.getByRole("heading", { name: "Sign in to iterate", exact: true }).waitFor();
  const response = await page.request.post(`${origin}/login`, {
    headers: { Authorization: `Bearer ${adminSecret(origin)}` },
    form: { email, next },
    maxRedirects: 0,
  });
  expect(response.status(), await response.text()).toBe(302);
  await response.dispose();
  await page.goto(new URL(next, origin).href);
}

test("the sign-in page refuses a wrong code in place, restarts for another email, and tells a signed-in browser where to go", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  test.skip(
    !acceptsTestCode(origin),
    "the code step needs a deployment that accepts the test code",
  );
  const email = `pages-${stamp()}@example.com`;
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText(`We sent a code to ${email}.`).waitFor();
  // a wrong code is refused where it was typed; the email is remembered
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("000000");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /not right/ })
    .waitFor();
  await page.getByText(`We sent a code to ${email}.`).waitFor();
  // another email: back to the first step, the code step gone
  await page.getByRole("button", { name: "Use a different email", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  expect(await page.getByRole("textbox", { name: "Code", exact: true }).count()).toBe(0);
  // signed in with nowhere asked for: the page says so and points onward (to the dash, where the
  // deployment has one — /login.json says), and can switch account
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("424242");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
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
  await page.goto(`${origin}/authorize?client_id=nope&response_type=code`);
  await page.getByRole("heading", { name: "Invalid authorization request", exact: true }).waitFor();
  await page.getByText(/could not be accepted: .*client_id/).waitFor();
  await page.getByText("Nothing was granted.").waitFor();
  expect(
    await page.getByRole("link", { name: "Back to iterate", exact: true }).getAttribute("href"),
  ).toBe("/");
  // typed by hand, with nothing at all
  await page.goto(`${origin}/authorize`);
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
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/login\?next=%2Fauthorize%3F/);
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
