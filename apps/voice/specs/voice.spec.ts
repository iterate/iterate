import { expect } from "@playwright/test";
import { test } from "../../os/specs/test.ts";

test("a new project installs its voice agent from the page, then has a Call button", async ({
  page,
  baseURL,
}) => {
  const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const slug = `voice-proof-${stamp}`;
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
    .fill("Voice rollout proof");
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(slug);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(
    (url) => url.origin === new URL(baseURL!).origin && url.pathname === `/projects/${slug}`,
  );

  // A fresh project has no voice agent, and no OpenAI key to give one.
  await expect(page.getByRole("button", { name: "Call", exact: true })).toHaveCount(0);
  // Installing only stores the key; health answers without calling OpenAI.
  await page.getByLabel("OpenAI API key").fill("voice-spec-placeholder-key");
  await page.getByRole("button", { name: "Install voice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Call", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Call", exact: true })).toBeVisible();
  await expect(page.getByLabel("OpenAI API key")).toHaveCount(0);
  expect(errors).toEqual([]);
});
