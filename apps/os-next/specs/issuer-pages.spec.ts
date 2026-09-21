// Browser acceptance for the issuer's pages around the consent flow (auth.spec.ts drives that one
// end to end): the sign-in page's own states, the invalid-request page, and a consent page whose
// session ends underneath it. Like auth.spec.ts these run against the local worker or, with
// DEMO_BASE_URL, a deployment.
import { expect, test, type Page } from "@playwright/test";
import { authorizationCodeRequest } from "iterate/next/oauth";

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
