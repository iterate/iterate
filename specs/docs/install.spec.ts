// A project that serves Docs but hasn't installed it gets it from a doc's page: one click commits
// `docs.ts` and the pin to its config, and the doc opens once the project runs them.
import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { docsModule } from "@iterate-com/docs/install";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";
import { consent, docsBuild, routeDocs } from "./support.ts";

test("a project without Docs installs it from a doc's page, and the doc opens", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-install");
  const docUrl = projectUrlOf(ingressRouting, workerBaseUrl, {
    project: fixture.project.slug,
    routingSlug: "docs",
    path: `/projects/${fixture.project.slug}/config/plan.md`,
  })!;
  await routeDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.writeFile("plan.md", "# Plan\n");
  // the page installs this deployment's build, the PR's: wait until pkg.pr.new has this commit's
  await docsBuild();

  await page.goto(docUrl.href);
  if (ingressRouting?.type === "subdomains") await consent(page, docUrl.host);
  await page.getByRole("button", { name: "Install Docs in this project", exact: true }).click();

  const editor = page.getByRole("textbox", { name: "plan.md", exact: true });
  // "Installing…" lasts as long as the config's publication of it, which can outlast the usual spinner
  await spinnerWaiter.settings.run({ spinnerTimeout: 120_000 }, () => editor.click());
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();
  expect(await config.readFile("docs.ts")).toBe(docsModule.content);
});
