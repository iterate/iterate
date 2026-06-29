import { test } from "./test-support/test.ts";

test("project REPL accepts a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("basic-repl");
  await page.goto(`/projects/${fixture.project.slug}/repl`);
  await page.getByRole("button", { name: "Run" }).click();

  await page.getByTestId("itx-repl-visible-result").getByText(`"capabilities"`).waitFor();
});
