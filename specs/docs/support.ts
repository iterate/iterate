// What every Docs spec does first: serve Docs from the fixture's project, the way a project's own
// config worker would (apps/docs/config-worker.ts), and consent for its host where it is one.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { transformSync } from "esbuild";

/** The repository's actual config-worker source, pointed at the Docs Worker under test (its host
 *  and protocol: the source names production's, over https), written where the project's config
 *  worker lives: every host of the project reaches it, the `docs` routing slug fetches through. */
export async function publishDocsConfigWorker(itx: any, docsWorker: URL) {
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/docs/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  )
    .code.replace('"docs.iterate.workers.dev"', JSON.stringify(docsWorker.host))
    .replace('url.protocol = "https:"', `url.protocol = ${JSON.stringify(docsWorker.protocol)}`);
  expect(source).toContain(`url.host = ${JSON.stringify(docsWorker.host)}`);
  // after the project's own saga has published its seed, which would otherwise land after and win
  await itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  await itx.repos.get("/repos/config").writeFile("worker.ts", source);
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
