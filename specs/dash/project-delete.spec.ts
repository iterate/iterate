// The Dash deletes a project (/projects/<slug>, `session.projects.delete`): its organization's owner
// confirms, lands on the list without it, and the platform no longer names it. Its contexts and
// storage go after, on the project's own deletion saga (apps/os/src/project/processor.ts), which the
// workers test (apps/os/__workers-tests__/project-deletion.test.ts) proves end to end.
import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("an owner deletes their project from its page, lands on the list without it, and the platform no longer has it", async ({
  page,
  baseURL,
  helpers,
  operator,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("project-delete", { app: baseURL });
  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  // the person's only project: the list is empty
  await page.getByText("No projects yet — “New project” creates the first.").waitFor();
  expect((await operator.projects.list()).map((project) => project.id)).not.toContain(
    fixture.project.id,
  );
});
