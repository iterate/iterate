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
// host, the counter app (stateful Durable Object) renders its mini
// client-side page, increments over fetch, and repaints from the WebSocket
// broadcast — and the guestbook (a React app whose state is a stream-processor
// fold mirrored into Cap'n Web live state) takes a signature and pushes it
// live into a second tab — all through real project ingress, in a real browser.
test("the seeded hello, counter, and guestbook apps work after creating a project", async ({
  baseURL,
  helpers,
  page,
}) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  await using fixture = await helpers.createFixture("seeded-apps");

  // Kick the guestbook's cold worker-bundler build NOW so it overlaps the
  // hello and counter walks below: the guestbook is public (no auth partial
  // anywhere on it), so this plain GET reaches the router and its resolve
  // starts the app build. The response itself (a self-refreshing building
  // page) is irrelevant.
  await page.request.get(appUrl("guestbook", fixture.project.slug, baseURL!)).catch(() => {});

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

  // Guestbook: the seeded repo's second React app (apps/guestbook) — its
  // state is a stream-processor fold on the project stream, hosted in the
  // app's own Durable Object and mirrored into Cap'n Web live state. Its cold
  // build was kicked before the hello walk and has been running throughout,
  // so this wait only absorbs the tail of it.
  await page.goto(appUrl("guestbook", fixture.project.slug, baseURL!));
  await page.getByRole("heading", { name: "Guestbook" }).waitFor({ timeout: 120_000 });

  // The composer enables once the /api Cap'n Web session subscribes; the
  // entry below comes back over the pushed live-state patch, not the HTTP
  // response — signing appends to the stream, the wake spine folds it, and
  // the Durable Object republishes.
  const note = `note-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("your name").fill("Ada");
  await page.getByLabel("your message").fill(note);
  await page.getByRole("button", { name: "Sign" }).click();
  await page.getByText(note).waitFor({ timeout: 30_000 });

  // Multiplayer: a second tab sees the entry over ITS OWN live-state
  // subscription, and a signature there lands in the first tab without any
  // reload — the fold's wake delivery repaints every open socket.
  const second = await page.context().newPage();
  await second.goto(appUrl("guestbook", fixture.project.slug, baseURL!));
  await second.getByText(note).waitFor({ timeout: 30_000 });
  const secondNote = `note-${crypto.randomUUID().slice(0, 8)}`;
  await second.getByLabel("your name").fill("Grace");
  await second.getByLabel("your message").fill(secondNote);
  await second.getByRole("button", { name: "Sign" }).click();
  // The first tab is a passive observer of a mutation initiated in the
  // second tab, so it cannot truthfully render mutation progress for
  // spinner-waiter to follow. Keep the explicit live-delivery bound while
  // bypassing only the no-spinner 100ms fast-fail for this remote update.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByText(secondNote).waitFor({ timeout: 30_000 });
  });
  await second.close();
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

  // Kick the tanstack app's cold vite build NOW so it overlaps the whole
  // internal-app walk below: /api has no auth gate (it authenticates
  // in-band), so this plain GET reaches the stateful facet, whose resolve
  // starts the app's in-workerd worker-bundler build. The
  // response itself (an upgrade rejection) is irrelevant.
  await page.request.get(`${appUrl("tanstack", slug, baseURL!)}api`).catch(() => {});

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

  // The tanstack app is a second member-gated origin on the same project: the
  // project's shared todo list — a stateful dynamic worker whose rows live in
  // its Durable Object's SQLite (via sqlfu), served as TanStack-routed SSR
  // with a Cap'n Web live-state lane. Its own origin has no app cookie yet,
  // so the auth partial gates it exactly like the internal app did — and the
  // same OS session carries the "Continue with Iterate" hop. Same worker.ts
  // The auth gate answers BEFORE any build (the root worker gates the host,
  // then forwards); the cold vite build was kicked before the internal-app
  // walk above and has been running throughout, so the heading wait only
  // absorbs the tail of it (behind the self-refreshing building page).
  await page.goto(appUrl("tanstack", slug, baseURL!));
  await page.getByRole("heading", { name: "Sign in to Iterate" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Continue with Iterate" }).click({ timeout: 30_000 });
  await page.getByRole("heading", { name: "TanStack todos" }).waitFor({ timeout: 120_000 });

  // The composer works once the Cap'n Web session authenticates (the
  // "connecting…" status hides), and the add comes back over live state.
  const todoTitle = `todo-${crypto.randomUUID().slice(0, 8)}`;
  const composer = page.getByLabel("add a todo");
  await composer.fill(todoTitle);
  await composer.press("Enter");
  await page.getByText(todoTitle).waitFor();

  // Multiplayer: a second tab (same member, same app cookie) sees the row
  // arrive over ITS OWN live-state subscription, and a toggle there strikes
  // through here without any reload.
  const second = await page.context().newPage();
  await second.goto(appUrl("tanstack", slug, baseURL!));
  await second.getByText(todoTitle).waitFor({ timeout: 30_000 });
  await second.getByLabel(`done: ${todoTitle}`).click();
  await page.locator(`input[aria-label="done: ${todoTitle}"]:checked`).waitFor();
  await second.close();

  // Durability: the row lives in the app's Durable Object SQLite, so a
  // fresh page load (new hydration, new /api session) replays it.
  await page.reload();
  await page.getByText(todoTitle).waitFor({ timeout: 30_000 });

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
