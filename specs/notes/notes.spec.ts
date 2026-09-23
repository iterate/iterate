import { expect } from "@playwright/test";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

test("sign in, create a project, save a note and read it after reload", async ({
  page,
  baseURL,
}) => {
  // Locally, no Notes app is a skip; in CI it is a failure (the preview's e2e job always has one).
  test.skip(
    !process.env.CI && !process.env.NOTES_BASE_URL,
    "The Notes specs need the Notes app deployed against the platform under test",
  );
  expect(process.env.NOTES_BASE_URL, "NOTES_BASE_URL: the preview's Notes app").toBeTruthy();
  const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const slug = `notes-proof-${stamp}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Log in with Iterate" }).click({ noWaitAfter: true });
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(`${slug}@example.com`);
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  if (!(await password.isVisible()))
    await page.getByRole("button", { name: /^(Continue|Use password instead)$/ }).click();
  await password.fill(readOsPlaywrightAuthConfig().loginPassword);
  // noWaitAfter: the post navigates; the next locator waits for it (the spinner-waiter counts a
  // navigation in flight as loading), not the click's tight action timeout
  await page.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
  await page
    .getByRole("textbox", { name: "Organization name", exact: true })
    .fill("Notes rollout proof");
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(slug);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  // back on the Notes app, on the new project's page
  const note = page.getByRole("textbox", { name: "/repos/config/notes/log.md" });
  await note.fill(`Notes deployment proof ${stamp}`);
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: new URL(baseURL!).origin,
    pathname: `/projects/${slug}`,
  });
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
  expect(await note.inputValue()).toBe(`Notes deployment proof ${stamp}`);
  expect(errors).toEqual([]);
});
