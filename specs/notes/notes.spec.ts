import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a note saved on the Notes app reads back after reload", async ({
  page,
  baseURL,
  helpers,
}) => {
  // Locally, no Notes app is a skip; in CI it is a failure (the preview's e2e job always has one).
  test.skip(
    !process.env.CI && !process.env.NOTES_BASE_URL,
    "The Notes specs need the Notes app deployed against the platform under test",
  );
  expect(process.env.NOTES_BASE_URL, "NOTES_BASE_URL: the preview's Notes app").toBeTruthy();
  // signed in to the Notes app, on the new project's page
  await using fixture = await helpers.createFixture("notes", { app: baseURL });
  const text = `Notes deployment proof ${fixture.project.slug}`;
  const note = page.getByRole("textbox", { name: "/repos/config/notes/log.md" });
  await note.fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: /^At commit / })
    .waitFor();
  expect(await note.inputValue()).toBe(text);
});
