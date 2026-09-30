// Comments on a doc: events on the doc's own context, never text in the file. A comment on a typo
// reaches another member live, their reply reaches its author, an agent's commit fixing the typo
// leaves the comment on the corrected word, an agent replies as packages/docs/AGENTS.md says and
// the page names it, and any member may resolve it.
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("two people comment on a typo, an agent fixes it and the comment stays on the word, and one of them resolves it", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs");
  const docUrl = projectUrlOf(ingressRouting, workerBaseUrl, {
    project: fixture.project.slug,
    routingSlug: "docs",
    path: `/projects/${fixture.project.slug}/config/plan.md`,
  })!;
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.writeFile("plan.md", "# Offsite\n\nHotle is booked for three nights.\n");

  await page.goto(docUrl.href);
  if (ingressRouting?.type === "subdomains") await consent(page, docUrl.host);
  const editor = page.getByRole("textbox", { name: "plan.md", exact: true });
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();

  // Misha selects the typo and comments on it
  await editor.getByText("Hotle is booked").click();
  await editor.press("Home");
  for (let i = 0; i < "Hotle".length; i++) await editor.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Which hotel?");
  await page.getByRole("textbox", { name: "Comment", exact: true }).press("ControlOrMeta+Enter");
  const onTypo = page.getByRole("article", { name: "Comment on “Hotle”" });
  await onTypo.filter({ hasText: "Which hotel?" }).waitFor();

  // Jonas opens the doc: Misha's comment is there, and his reply reaches Misha live
  await using jonas = await helpers.createMember(fixture, "jonas");
  await jonas.page.goto(docUrl.href);
  if (ingressRouting?.type === "subdomains") await consent(jonas.page, docUrl.host);
  const jonasOnTypo = jonas.page.getByRole("article", { name: "Comment on “Hotle”" });
  await jonasOnTypo.filter({ hasText: fixture.email.split("@")[0]! }).click();
  await jonasOnTypo.getByRole("textbox", { name: "Reply" }).fill("The one by the station.");
  await jonasOnTypo.getByRole("button", { name: "Reply" }).click();
  // timeout: another person's comment, so the spinner-waiter has nothing to extend by
  await onTypo.filter({ hasText: "The one by the station." }).waitFor({ timeout: 10_000 });

  // An agent fixes the typo in a commit: the text under the comment changed, and the doc's
  // processor moves the comment's quote to the corrected word
  await config.writeFile("plan.md", "# Offsite\n\nHotel is booked for three nights.\n");
  const onFix = page.getByRole("article", { name: "Comment on “Hotel”" });
  // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
  await onFix.filter({ hasText: "The one by the station." }).waitFor({ timeout: 10_000 });
  await jonas.page.getByRole("article", { name: "Comment on “Hotel”" }).waitFor();

  // An agent working for Misha replies, reading the thread and appending the reply as the agent
  // guide says; the page shows who it was
  const doc = fixture.itx.cd("/docs/config/plan.md");
  const { state }: any = await doc.invoke("itx.facets.get('doc').liveSnapshot()");
  await doc.append({
    type: "docs/comment-replied",
    payload: {
      thread: state.threads[0].id,
      comment: crypto.randomUUID(),
      body: "Booked at the one by the station.",
      via: "Claude Code",
    },
  });
  // timeout: an agent's reply, so the spinner-waiter has nothing to extend by
  await onFix.filter({ hasText: "· Claude Code" }).waitFor({ timeout: 10_000 });

  // Jonas resolves it: anyone can, and it folds away for Misha too
  await jonas.page
    .getByRole("article", { name: "Comment on “Hotel”" })
    .getByRole("button", { name: "Resolve" })
    .click();
  // timeout: another person's resolve, so the spinner-waiter has nothing to extend by
  await page.getByText("Resolved (1)").waitFor({ timeout: 10_000 });
});
