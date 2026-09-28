// Docs, served through a project's config worker (apps/docs/config-worker.ts) like Notes: a new doc
// from the list, written with the editor's shortcuts, autosaved to /repos/docs, and a commit made
// elsewhere (by an agent, say) merged into what's being typed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { transformSync } from "esbuild";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";

test("a doc is written with the editor's shortcuts, autosaves, and takes in a commit made elsewhere", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs");
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: fixture.project.slug,
      routingSlug: "docs",
      path,
    })!;
  await publishDocsConfigWorker(fixture.itx, new URL(helpers.appOrigin("docs")));
  await page.goto(proxied("/projects").href);
  if (ingressRouting?.type === "subdomains") await consent(page, proxied("/").host);

  await page.getByRole("textbox", { name: "New doc title", exact: true }).fill("Lisbon offsite");
  await page.getByRole("button", { name: "New doc", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "lisbon-offsite.md", exact: true });
  await editor.waitFor();
  const docs = fixture.itx.repos.get("/repos/docs");
  const saved = () => docs.readFile("lisbon-offsite.md");
  await expect.poll(saved).toBe("# Lisbon offsite\n");

  // Cmd/Ctrl-B bolds; the app shell's sidebar, which toggles on the same keys, stays as it was.
  // Tab nests a list item and the editor keeps focus.
  const sidebarState = await page
    .locator('[data-slot="sidebar"][data-state]')
    .getAttribute("data-state");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("Tuesday");
  await editor.press("Shift+Home");
  await editor.press("ControlOrMeta+b");
  await editor.press("End");
  await editor.pressSequentially(" 13 October");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("- Retro");
  await editor.press("Enter");
  await editor.pressSequentially("One slide each");
  await editor.press("Tab");
  await editor.and(page.locator(":focus")).waitFor();
  await page.locator(`[data-slot="sidebar"][data-state="${sidebarState}"]`).waitFor();
  await expect
    .poll(saved)
    .toBe("# Lisbon offsite\n\n**Tuesday** 13 October\n\n- Retro\n  - One slide each");
  await page
    .getByRole("status")
    .filter({ hasText: /^Saved [0-9a-f]{7}$/ })
    .waitFor();

  // Someone else commits to the doc; the next autosave is refused, merges theirs in and saves.
  await docs.writeFile(
    "lisbon-offsite.md",
    (await saved())!.replace("# Lisbon offsite", "# Lisbon offsite, October 2026"),
  );
  // the third line, which their commit didn't touch
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.pressSequentially(" and leave Friday.");
  await page
    .getByRole("status")
    .filter({ hasText: /with someone else's changes merged in$/ })
    .waitFor();
  await editor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor();
  await expect
    .poll(saved)
    .toBe(
      "# Lisbon offsite, October 2026\n\n**Tuesday** 13 October and leave Friday.\n\n- Retro\n  - One slide each",
    );

  await page.reload();
  await editor.filter({ hasText: "and leave Friday." }).waitFor();
});

/** The repository's actual config-worker source, pointed at the Docs Worker under test (its host
 *  and protocol: the source names production's, over https), written where the project's config
 *  worker lives: every host of the project reaches it, the `docs` routing slug fetches through. */
async function publishDocsConfigWorker(itx: any, docsWorker: URL) {
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
async function consent(page: Page, host: string) {
  await page
    .getByRole("heading", { name: `${host} wants to access your account`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
}
