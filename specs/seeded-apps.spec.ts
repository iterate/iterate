import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { E2E_HEAVY_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The seeded config repo's example apps genuinely serve after a project is
// created: the hello app (stateless WorkerEntrypoint) answers JSON on its own
// host, and the counter app (stateful Durable Object) renders its mini
// client-side page, increments over fetch, and repaints from the WebSocket
// broadcast — all through real project ingress, in a real browser.
test("the seeded hello and counter apps work after creating a project", async ({
  baseURL,
  helpers,
  page,
}) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  await using fixture = await helpers.createFixture("seeded-apps");

  // Hello: an app's first use is a cold worker build; the router serves a
  // self-refreshing "building" page until the artifact lands, so seeing the
  // JSON body means the build completed and ingress routed the host. The
  // building page is the progress UI — 120s mirrors the ingress e2e's
  // cold-build budget.
  await page.goto(appUrl("hello", fixture.project.slug, baseURL!));
  await page.getByText('"app":"hello"').waitFor({ timeout: 120_000 });
  await page.getByText(fixture.project.id).waitFor();

  // Counter: same repo source as hello (one worker.ts), so its artifact is
  // already built — but keep the cold-build budget in case the stateful
  // facet's first start is slow.
  await page.goto(appUrl("counter", fixture.project.slug, baseURL!));
  await page.getByText("count:").waitFor({ timeout: 120_000 });

  // The increment button enables only when the page's WebSocket opens, so
  // this click also proves the live socket lane; the repaint below comes from
  // the ws broadcast, not the HTTP response.
  await page.getByRole("button", { name: "increment" }).click();
  await page.locator("#n").filter({ hasText: /^1$/ }).waitFor();
});

// Unlike the public examples above, this proof uses a real Auth-backed user
// and organization: project-member auth deliberately checks the live Auth
// directory on every request, not merely the OS access-token claims used by
// the suite's usual forged-session fixture.
test("the seeded internal app authenticates a real project member", async ({ baseURL, page }) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  test.skip(
    !(await startEmailOtpSignIn(page)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("internal-app-auth");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("internal-app-auth"),
    projectSlug: slug,
  });

  // First-run onboarding creates the Auth directory membership and the
  // project together. Its destination renders an unmarked skeleton, so wait
  // for the project route with spinner-waiter disabled, as signup.spec.ts does.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });

  // Put a recognizable event on the root stream so the internal app proves
  // both authorization and post-auth access to this fixture's project data.
  const marker = `authenticated-internal-app-${crypto.randomUUID()}`;
  using admin = await connectAdminItx(baseURL!);
  using project = admin.projects.get(slug);
  using root = project.streams.get("/");
  await root.append({
    type: "events.iterate.test/spec/authenticated-internal-app",
    payload: { marker },
  });

  // The project-app origin has no session yet, even though this browser is
  // already signed in to OS. The auth partial owns the request and renders
  // the form on the app's own origin.
  const internalUrl = appUrl("internal", slug, baseURL!);
  await page.goto(internalUrl);
  // A named app's first use may still need its own cold worker start. The
  // platform's building page is visible progress; 120s matches hello above.
  await page.getByRole("heading", { name: "Sign in to Iterate" }).waitFor({ timeout: 120_000 });
  await page.getByText("This app is available to project members.").waitFor();

  // This follows app -> OS -> app callback. OS reuses the iterate_session
  // cookie installed by the signup flow; the callback redeems a fragment token
  // into an app-host-only HttpOnly cookie before returning to `/`. The click
  // waits through two origins and three navigations, so give that bounded
  // protocol work a wider budget than an ordinary in-page action.
  await page.getByRole("button", { name: "Continue with Iterate" }).click({ timeout: 30_000 });
  await page
    .getByRole("heading", { name: "Latest project root events" })
    .waitFor({ timeout: 30_000 });
  await page.getByText(marker).waitFor();

  // `/api` is an unauthenticated Cap'n Web root. The page explicitly
  // exchanges its exact-origin app cookie for an app-defined session target;
  // only that attenuated target (not project ITX) reaches the browser.
  await page
    .locator("#identity")
    .filter({ hasText: /^authenticated as \S+$/ })
    .waitFor();
  const refresh = page.getByRole("button", { name: "refresh over Cap'n Web" });

  // Prove the session's LiveState channel, rather than the initial HTML: add
  // an event after render, invoke the app-session RPC method, and wait for the
  // pushed snapshot/patch projection to repaint the page.
  const liveMarker = `capnweb-live-state-${crypto.randomUUID()}`;
  await root.append({
    type: "events.iterate.test/spec/internal-app-live-state",
    payload: { marker: liveMarker },
  });
  await refresh.click();
  await page.getByText(liveMarker).waitFor();

  // Partial-fetch fall-through must preserve the original request. Exercise
  // that contract across the real dynamic-worker + ITX RPC boundary, not just
  // in the auth helper: the protected app reads this POST body after auth has
  // returned null.
  const echoBody = `app-owned-body-${crypto.randomUUID()}`;
  const echo = await page.evaluate(async (body) => {
    const response = await fetch("/echo", { body, method: "POST" });
    return { body: await response.text(), status: response.status };
  }, echoBody);
  expect(echo).toEqual({ body: echoBody, status: 200 });

  // The tanstack app is a second member-gated origin on the same project: a
  // server-rendered TanStack Router + React page. Its own origin has no app
  // cookie yet, so the auth partial gates it exactly like the internal app
  // did — and the same OS session carries the "Continue with Iterate" hop.
  // Same worker.ts artifact as the apps above, so no cold build; the 120s
  // budget covers a cold stateless-facet start.
  await page.goto(appUrl("tanstack", slug, baseURL!));
  await page.getByRole("heading", { name: "Sign in to Iterate" }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Continue with Iterate" }).click({ timeout: 30_000 });
  await page.getByRole("heading", { name: "TanStack on Iterate" }).waitFor({ timeout: 30_000 });
  await page.getByText(/^Signed in as/).waitFor();

  // Server-side routing proof: the about link is a plain anchor — no client
  // bundle exists, so this navigation is a full request the worker's router
  // matches and renders.
  await page.getByRole("link", { name: "about" }).click();
  await page.getByText("Server-side routing proof").waitFor();

  // Logout is owned by the same partial. It clears the app-host cookie and
  // the redirected request is gated back to the login form.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to Iterate" }).waitFor();
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
