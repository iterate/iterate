import { expect } from "@playwright/test";
import { test } from "../../os/specs/test.ts";

test("sign in, create a project, save a note and read it after reload", async ({
  page,
  baseURL,
}) => {
  const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const slug = `notes-proof-${stamp}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Log in with Iterate" }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(`${slug}@example.com`);
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  if (!(await password.isVisible()))
    await page.getByRole("button", { name: /^(Continue|Use password instead)$/ }).click();
  await password.fill(process.env.LOGIN_PASSWORD || "dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Organization name", exact: true })
    .fill("Notes rollout proof");
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(slug);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(
    (url) => url.origin === new URL(baseURL!).origin && url.pathname === `/projects/${slug}`,
  );
  const note = page.getByRole("textbox", { name: "/repos/config/notes/log.md" });
  await note.fill(`Notes deployment proof ${stamp}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.reload();
  await expect(note).toHaveValue(`Notes deployment proof ${stamp}`);
  await page
    .getByRole("status")
    .filter({ hasText: /^At commit / })
    .waitFor();
  expect(errors).toEqual([]);
});
