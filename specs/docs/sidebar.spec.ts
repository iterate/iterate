// The sidebar lists a project's docs as a tree, folders from their paths, and follows the repo: a
// doc an agent commits shows up without a reload. ⌘K (the shell's palette) finds a doc by name,
// one in a closed folder included.
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";
import { consent, publishDocsConfigWorker } from "./support.ts";

test("the sidebar shows the docs as a tree, follows a doc an agent adds, and ⌘K finds a doc by name", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-nav");
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: fixture.project.slug,
      routingSlug: "docs",
      path,
    })!;
  await publishDocsConfigWorker(fixture.itx, new URL(helpers.appOrigin("docs")));
  await page.goto(proxied("/projects").href);
  if (ingressRouting?.type === "subdomains") await consent(page, proxied("/").host);

  // a title with a slash makes the doc in a folder, which the sidebar opens to show it highlighted
  await page
    .getByRole("textbox", { name: "New doc title", exact: true })
    .fill("Offsites/Lisbon offsite");
  await page.getByRole("button", { name: "New doc", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "offsites/lisbon-offsite.md", exact: true });
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();
  await editor.filter({ hasText: "Lisbon offsite" }).waitFor();
  const sidebar = page.locator('[data-slot="sidebar"]');
  // a folder is a <details>: its row is the <summary>
  await sidebar
    .locator("summary")
    .filter({ hasText: /^offsites$/ })
    .waitFor();
  await sidebar
    .getByRole("link", { name: "lisbon-offsite", exact: true })
    .and(page.locator("[data-active]"))
    .waitFor();

  // an agent commits a doc in another folder: it is in the sidebar without a reload, its folder shut
  await fixture.itx.repos.get("/repos/docs").writeFile("plans/q4-roadmap.md", "# Q4 roadmap\n");
  // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
  await sidebar
    .locator("summary")
    .filter({ hasText: /^plans$/ })
    .waitFor({ timeout: 10_000 });

  // ⌘K finds it by name, though its folder is shut, and opens it
  await sidebar.getByRole("button", { name: "Search" }).click();
  await page.getByRole("combobox", { name: "Search projects and pages" }).fill("roadmap");
  await page.getByRole("option", { name: /q4-roadmap/ }).click();
  await page
    .getByRole("textbox", { name: "plans/q4-roadmap.md", exact: true })
    .filter({ hasText: "Q4 roadmap" })
    .waitFor();
});
