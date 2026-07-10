import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

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
  await expect(page.locator("#n")).toHaveText("1");
});
