// Docs opens a repo's other files too: an html file on a Preview of its live text, its Source a
// code editor; any other text file in a code editor alone; and a binary file not at all.
import { expect } from "@playwright/test";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../../helpers/auth-config.ts";
import { test } from "../../helpers/test.ts";
import { workerBaseUrl } from "../../helpers/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("an html file opens on its preview and edits as source, a script in a code editor, and a binary file says it isn't text", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-files");
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: fixture.project.slug,
      routingSlug: "docs",
      path,
    })!;
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.commitFiles({
    message: "Files that aren't markdown",
    parent: await config.tip(),
    changes: [
      { path: "site/welcome.html", content: "<h1>Welcome aboard</h1>\n" },
      { path: "scripts/greet.ts", content: 'export const greeting = "hello";\n' },
      { path: "assets/logo.png", content: "not really a png" },
    ],
  });
  const doc = (path: string) => proxied(`/projects/${fixture.project.slug}/config/${path}`).href;

  await page.goto(doc("site/welcome.html"));
  if (ingressRouting?.type === "subdomains") await consent(page, proxied("/").host);
  await page
    .frameLocator('iframe[title="Preview of site/welcome.html"]')
    .getByRole("heading", { name: "Welcome aboard" })
    .waitFor();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.getByRole("textbox", { name: "site/welcome.html", exact: true });
  await source.and(page.locator('[contenteditable="true"]')).waitFor();
  await source.filter({ hasText: "<h1>Welcome aboard</h1>" }).waitFor();
  // the preview follows the text
  await source.press("ControlOrMeta+End");
  await source.pressSequentially("<p>Mind the gap</p>");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page
    .frameLocator('iframe[title="Preview of site/welcome.html"]')
    .getByText("Mind the gap")
    .waitFor();

  await page.goto(doc("scripts/greet.ts"));
  const script = page.getByRole("textbox", { name: "scripts/greet.ts", exact: true });
  await script.and(page.locator('[contenteditable="true"]')).waitFor();
  await script.filter({ hasText: 'export const greeting = "hello";' }).waitFor();
  // a code file has one view: no Rich / Markdown or Preview / Source
  await expect.poll(() => page.getByRole("group", { name: "Mode" }).count()).toBe(0);

  await page.goto(doc("assets/logo.png"));
  await page.getByText("logo.png isn't text").waitFor();
});
