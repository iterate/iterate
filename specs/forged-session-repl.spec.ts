import { test } from "./test-support/test.ts";

test("project REPL accepts a forged session", async ({ createProjectFixture, page }) => {
  await using projectFixture = await createProjectFixture("basic-repl");
  await page.goto(`/projects/${projectFixture.project.slug}/repl`);
  await page.getByRole("button", { name: "Run" }).click();

  await page.getByText(`"capabilities"`).waitFor();
});
