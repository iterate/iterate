import { createProjectFixture } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

test("project REPL accepts a directly minted JWT session cookie", async ({ baseURL, page }) => {
  await using projectFixture = await createProjectFixture("basic-repl", { baseURL, page });
  await page.goto(`/projects/${projectFixture.project.slug}/repl`);
  await page.getByRole("button", { name: "Run" }).click();

  await page.getByText(`"capabilities"`).waitFor();
});
