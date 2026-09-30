// What every Docs spec does first: have the fixture's project serve Docs the way a project does,
// a members-only fetch route from its `docs` routing slug to the Docs Worker under test (the route
// a PR preview's `pr<N>` gets, scripts/os/preview-config.ts `proxiedAppRoute`), and install
// Docs in its config (`docs.ts` and a pin, @iterate-com/docs/install) at this commit's build. Then
// consent for its host where it is one.
import { expect, type Page } from "@playwright/test";
import { installDocs } from "@iterate-com/docs/install";
import { pkgPrNewVersion } from "iterate/pkg-pr-new";
import { proxiedAppRoute } from "../../scripts/os/preview-config.ts";

export async function serveDocs(itx: any, docsWorker: URL) {
  await routeDocs(itx, docsWorker);
  await installDocs(itx, await docsBuild());
}

/** The project serving Docs without installing it: its `docs` fetch route alone. */
export async function routeDocs(itx: any, docsWorker: URL) {
  // after the project's own saga has published its seed, which would otherwise land after and win
  await itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  await itx.fetchRoutes.set("docs", proxiedAppRoute("docs", docsWorker.href));
}

/** @iterate-com/docs at the commit specs/setup.ts sets as `PUBLISHED_PACKAGE_COMMIT`
 *  (apps/os/scripts/published-package-commit.ts says which), once pkg.pr.new serves it. */
export async function docsBuild() {
  const commit = process.env.PUBLISHED_PACKAGE_COMMIT;
  if (!commit)
    throw new Error("specs/setup.ts sets PUBLISHED_PACKAGE_COMMIT before the workers start");
  const version = pkgPrNewVersion("@iterate-com/docs", commit);
  await expect
    .poll(async () => (await fetch(version, { method: "HEAD" })).status, {
      // timeout: fixture setup before any page, so the spinner-waiter has nothing to extend by; pkg.pr.new publishes a push's build beside its preview deploy, in about a minute
      timeout: 120_000,
    })
    .toBe(200);
  return version;
}

/** Consent for the proxied host, a client of its own under subdomains: review, then Authorize,
 *  which hands the browser back to the page. */
export async function consent(page: Page, host: string) {
  await page
    .getByRole("heading", { name: `${host} wants to access your account`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
}
