// Docs, served through a project's config worker (apps/docs/config-worker.ts) like Notes: a new doc
// in the project's config repo, written with the editor's shortcuts and co-edited live by two
// people through the doc's processor (@iterate-com/docs); a commit an agent makes reaches both open
// editors; and when both have left, the processor commits it all at once, the first to type as the
// author and the other as co-author.
import { expect } from "@playwright/test";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";
import { consent, publishDocsConfigWorker } from "./support.ts";

test("two people write a doc together: shortcuts, each other's typing live, an agent's commit live, and one commit when they leave", async ({
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

  // a project's docs open on its config repo
  await page.getByRole("textbox", { name: "New doc title", exact: true }).fill("Lisbon offsite");
  await page.getByRole("button", { name: "New doc", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "lisbon-offsite.md", exact: true });
  // read-only on the loaded text until the doc's processor has synced ("Opening…")
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();
  const config = fixture.itx.repos.get("/repos/config");
  const saved = () => config.readFile("lisbon-offsite.md");
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

  // Jonas, a member of the same organization, opens the doc in his own browser: he gets Misha's
  // unsaved text, each sees the other is here, and what he types reaches Misha without a reload.
  await using jonas = await helpers.createMember(fixture, "jonas");
  await jonas.page.goto(proxied(`/projects/${fixture.project.slug}/config/lisbon-offsite.md`).href);
  if (ingressRouting?.type === "subdomains") await consent(jonas.page, proxied("/").host);
  const jonasEditor = jonas.page.getByRole("textbox", { name: "lisbon-offsite.md", exact: true });
  await jonasEditor.and(jonas.page.locator('[contenteditable="true"]')).waitFor();
  await jonasEditor.filter({ hasText: "One slide each" }).waitFor();
  await page.getByLabel("Also here").filter({ hasText: jonas.email }).waitFor();
  await jonas.page.getByLabel("Also here").filter({ hasText: fixture.email }).waitFor();

  await jonasEditor.press("ControlOrMeta+End");
  await jonasEditor.press("Enter");
  await jonasEditor.press("Shift+Tab");
  await jonasEditor.pressSequentially("Book the boat");
  // timeout: another person's typing, so the spinner-waiter has nothing to extend by
  await editor.filter({ hasText: "Book the boat" }).waitFor({ timeout: 10_000 });

  // An agent commits to the doc: the root's docs processor tells the doc's, which merges the
  // commit into the live text and sends it to both editors.
  await config.writeFile(
    "lisbon-offsite.md",
    (await saved())!.replace("# Lisbon offsite", "# Lisbon offsite, October 2026"),
  );
  // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
  await editor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor({ timeout: 10_000 });
  await jonasEditor.filter({ hasText: "Lisbon offsite, October 2026" }).waitFor();

  // Both leave the doc: the processor commits their edits then, not a minute later, as one
  // commit by Misha, who typed first, with Jonas as co-author.
  await page.getByRole("link", { name: "config", exact: true }).click();
  await jonas.page.getByRole("link", { name: "config", exact: true }).click();
  await expect
    .poll(saved)
    .toBe(
      "# Lisbon offsite, October 2026\n\n**Tuesday** 13 October\n\n- Retro\n  - One slide each\n- Book the boat",
    );
  await expect
    .poll(async () => (await config.log({ limit: 1 }))[0])
    .toMatchObject({
      author: { email: fixture.email },
      message: `docs: edit lisbon-offsite.md\n\nCo-authored-by: ${jonas.email} <${jonas.email}>`,
    });

  await page.goto(proxied(`/projects/${fixture.project.slug}/config/lisbon-offsite.md`).href);
  await editor.filter({ hasText: "Book the boat" }).waitFor();
});
