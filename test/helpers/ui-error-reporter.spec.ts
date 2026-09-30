// The harness's ui-error-reporter (test.ts) reads `[data-type="error"]`, the marker the apps put on
// their error UI: a failed action's message quotes whatever error the page shows.
import { expect } from "@playwright/test";
import { test } from "./test.ts";

test("a failed action quotes the error UI the page shows", async ({ page }) => {
  await page.setContent(`<main><p data-type="error">The commit was refused</p></main>`);

  const failure = await page
    .getByRole("button", { name: "Save", exact: true })
    .click()
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(failure).toMatchObject({
    message: expect.stringMatching(/Error UI visible:[\s\S]*"The commit was refused"/),
  });
});
