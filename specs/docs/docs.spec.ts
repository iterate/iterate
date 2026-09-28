// Docs, served through a project's config worker (apps/docs/config-worker.ts) like Notes: a new doc
// from the list, written with the editor's shortcuts, co-edited live by two people through the
// doc's processor (@iterate-com/docs), which saves it to /repos/docs; a commit made elsewhere (by an
// agent, say) reaches both open editors.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { transformSync } from "esbuild";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { mintIterateSession } from "../test-support/forged-session.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";

test("two people write a doc together: shortcuts, each other's typing live, an agent's commit live, and the doc saves itself", async ({
  page,
  browser,
  helpers,
  operator,
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
  // read-only on the loaded text until the doc's processor has synced ("Opening…")
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();
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
    .filter({ hasText: new RegExp(`^Saved [0-9a-f]{7} \\(${fixture.email}\\)$`) })
    .waitFor();

  // Jonas, a member of the same organization, opens the doc in his own browser: each sees the
  // other is here, and what he types reaches Misha's editor without a reload.
  const jonas = `jonas-${fixture.email}`;
  await operator.users.create({ email: jonas });
  using session = openOperatorSession();
  const owner = session.authenticate({ email: fixture.email });
  const [org] = await owner.organizations.list();
  await owner.organizations.addMember(org!.id, { userId: jonas, role: "member" });
  await using jonasContext = await browser.newContext();
  const jonasPage = await jonasContext.newPage();
  await mintIterateSession({ email: jonas, page: jonasPage });
  await jonasPage.goto(proxied(`/projects/${fixture.project.slug}/lisbon-offsite.md`).href);
  if (ingressRouting?.type === "subdomains") await consent(jonasPage, proxied("/").host);
  const jonasEditor = jonasPage.getByRole("textbox", { name: "lisbon-offsite.md", exact: true });
  await jonasEditor.and(jonasPage.locator('[contenteditable="true"]')).waitFor();
  await page.getByLabel("Also here").filter({ hasText: jonas }).waitFor();
  await jonasPage.getByLabel("Also here").filter({ hasText: fixture.email }).waitFor();

  await jonasEditor.press("ControlOrMeta+End");
  await jonasEditor.press("Enter");
  await jonasEditor.press("Shift+Tab");
  await jonasEditor.pressSequentially("Book the boat");
  // timeout: another person's typing, so the spinner-waiter has nothing to extend by
  await editor.filter({ hasText: "Book the boat" }).waitFor({ timeout: 10_000 });
  await expect
    .poll(saved)
    .toBe(
      "# Lisbon offsite\n\n**Tuesday** 13 October\n\n- Retro\n  - One slide each\n- Book the boat",
    );
  await expect
    .poll(async () => (await docs.log({ limit: 1 }))[0])
    .toMatchObject({
      author: { email: jonas },
    });

  // An agent commits to the doc: the root's docs processor tells the doc's, which merges the
  // commit into the live text and sends it to both editors.
  await docs.writeFile(
    "lisbon-offsite.md",
    (await saved())!.replace("# Lisbon offsite", "# Lisbon offsite, October 2026"),
  );
  // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
  await editor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor({ timeout: 10_000 });
  await jonasEditor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor();

  await page.reload();
  await editor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor();
  await editor.filter({ hasText: "Book the boat" }).waitFor();
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
