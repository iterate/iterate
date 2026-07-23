import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { E2E_HEAVY_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { test } from "./test-support/test.ts";

// The seeded config repo's example apps genuinely serve after a project is
// created: the guestbook (stream-processor reduce on /guestbook, Cap'n Web
// live state) takes a signature and pushes it live — through real project
// ingress, in a real browser.
test("the seeded guestbook app works after creating a project", async ({
  baseURL,
  helpers,
  page,
}) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  await using fixture = await helpers.createFixture("seeded-apps");

  // Guestbook: worker-bundler installs the deployment-pinned Iterate package
  // plus its shared Cap'n Web alias and compiles client.tsx into the browser
  // module. Seeing the signed note proves that the SDK's LiveState target and
  // the app's RPC root share one Cap'n Web class identity end to end.
  await page.goto(appUrl("guestbook", fixture.project.slug, baseURL!));
  await page.getByRole("heading", { name: "Guestbook" }).waitFor({ timeout: 120_000 });

  const note = `note-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Message").fill(note);
  await page.getByRole("button", { name: "Sign guestbook" }).click();
  await page.getByText(note).waitFor({ timeout: 30_000 });

  await page.reload();
  await page.getByText(note).waitFor({ timeout: 30_000 });
});

// Unlike the public guestbook above, this proof uses a real Auth-backed user
// and organization: project-member auth deliberately checks the live Auth
// directory on every request, not merely the OS access-token claims used by
// the suite's usual forged-session fixture.
test("the seeded todo app authenticates a real project member", async ({
  baseURL,
  page,
}, testInfo) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  test.skip(
    !(await startEmailOtpSignIn(page)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("todo-app-auth");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("todo-app-auth"),
    projectSlug: slug,
    testInfo,
  });

  // First-run onboarding creates the Auth directory membership and the
  // project together. Its destination renders an unmarked skeleton, so wait
  // for the project route with spinner-waiter disabled, as signup.spec.ts does.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });

  // The project-app origin has no session yet, even though this browser is
  // already signed in to OS. The auth partial owns the request and renders
  // the form on the app's own origin, under its strict CSP; the platform's
  // worker-status overlay must ride that CSP via its nonce, not inline
  // script.
  const todoUrl = appUrl("todo", slug, baseURL!);
  const signInResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === todoUrl &&
      response.request().resourceType() === "document" &&
      response.headers()["content-security-policy"]?.includes("default-src 'none'") === true,
    { timeout: 120_000 },
  );
  await page.goto(todoUrl);
  // The app's first use may still need its own cold worker start. The
  // platform's building page is visible progress; 120s mirrors the ingress
  // e2e's cold-build budget.
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor({ timeout: 120_000 });
  await page.getByText("This app is available to project members.").waitFor();
  const signInResponse = await signInResponsePromise;
  const overlay = page.locator("iterate-worker-status[data-iterate-worker-overlay]");
  await overlay.waitFor({ state: "visible" });
  expect(await overlay.locator("script").count()).toBe(0);
  const overlayNonce = await overlay
    .locator("style")
    .evaluate((style: HTMLStyleElement) => style.nonce);
  expect(overlayNonce).not.toBe("");
  expect(signInResponse.headers()["content-security-policy"]).toContain(`'nonce-${overlayNonce}'`);

  // This follows app -> OS -> app callback. OS reuses the iterate_session
  // cookie installed by the signup flow; the callback redeems a fragment token
  // into an app-host-only HttpOnly cookie before returning to `/`. The click
  // waits through two origins and three navigations, then worker-bundler
  // transforms the package-backed server and compiles the browser entry —
  // preserve the real cold-build deadline instead of letting spinner-waiter
  // collapse the wait to its no-spinner fast-fail.
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 });

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByRole("heading", { name: "Todo" }).waitFor({ timeout: 120_000 });
  });

  const todoTitle = `todo-${crypto.randomUUID().slice(0, 8)}`;
  const composer = page.getByLabel("New todo");
  await composer.fill(todoTitle);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByText(todoTitle).waitFor();

  await page.getByLabel(`Mark ${todoTitle} done`).click();
  await page.getByLabel(`Mark ${todoTitle} not done`).waitFor();

  // Durability: the row and its completed state live in the app's Durable
  // Object state, so a fresh page load reads them back.
  await page.reload();
  await page.getByText(todoTitle).waitFor({ timeout: 30_000 });
  await page.getByRole("checkbox", { checked: true, name: `Mark ${todoTitle} not done` }).waitFor();
});

/**
 * App hosts are `<app>--<project>.<base>`, one origin per app. Locally the
 * base is the dev server's `.localhost` port (Chromium resolves `*.localhost`
 * to loopback natively — no Host-header tricks needed, unlike Node fetch);
 * deployed runs read the wildcard base from APP_CONFIG_PROJECT_HOSTNAME_BASES
 * with the same preview-hostname fallback as the ingress e2e.
 */
function appUrl(appSlug: string, projectSlug: string, baseURL: string) {
  const base = new URL(baseURL);
  if (base.hostname === "localhost" || base.hostname.endsWith(".localhost")) {
    return `${base.protocol}//${appSlug}--${projectSlug}.localhost${base.port ? `:${base.port}` : ""}/`;
  }
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  return `${base.protocol}//${appSlug}--${projectSlug}.${projectBase}/`;
}
