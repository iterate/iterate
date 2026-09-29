// The sidebar lists the files of one of the project's repos as a tree (@pierre/trees), folders from
// their paths, and follows the repo: a doc an agent commits shows up without a reload. Its picker
// switches repo. ⌘K (the shell's palette) finds a file by name, one in a closed folder included.
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("the sidebar shows a repo's docs as a tree, follows a doc an agent adds, switches repo, and ⌘K finds a doc by name", async ({
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
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  // another repo of the project, with a doc of its own
  await fixture.itx.repos.create("/repos/handbook");
  await fixture.itx.repos.get("/repos/handbook").writeFile("welcome.md", "# Welcome\n");
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
  const tree = page.locator('[data-slot="sidebar"]').getByRole("tree");
  await tree.getByRole("treeitem", { name: "offsites", exact: true, expanded: true }).waitFor();
  await tree
    .getByRole("treeitem", { name: "lisbon-offsite.md", exact: true, selected: true })
    .waitFor();

  // an agent commits a doc in another folder: it is in the sidebar without a reload, its folder shut
  await fixture.itx.repos.get("/repos/config").writeFile("plans/q4-roadmap.md", "# Q4 roadmap\n");
  await tree
    .getByRole("treeitem", { name: "plans", exact: true, expanded: false })
    // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
    .waitFor({ timeout: 10_000 });

  // ⌘K finds it by name, though its folder is shut, and opens it
  await page.locator('[data-slot="sidebar"]').getByRole("button", { name: "Search" }).click();
  await page.getByRole("combobox", { name: "Search projects and pages" }).fill("roadmap");
  await page.getByRole("option", { name: /q4-roadmap\.md/ }).click();
  await page
    .getByRole("textbox", { name: "plans/q4-roadmap.md", exact: true })
    .filter({ hasText: "Q4 roadmap" })
    .waitFor();

  // the picker shows another repo's files
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole("combobox", { name: "Repo" })
    .selectOption("handbook");
  await tree.getByRole("treeitem", { name: "welcome.md", exact: true }).click();
  await page
    .getByRole("textbox", { name: "welcome.md", exact: true })
    .filter({ hasText: "Welcome" })
    .waitFor();
});
