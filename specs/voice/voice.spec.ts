import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a new project installs its voice agent from the page, then has a Call button", async ({
  page,
  baseURL,
}) => {
  // Locally, no Voice app is a skip; in CI it is a failure (the preview's e2e job always has one).
  test.skip(
    !process.env.CI && !process.env.VOICE_BASE_URL,
    "The Voice specs need the Voice app deployed against the platform under test",
  );
  expect(process.env.VOICE_BASE_URL, "VOICE_BASE_URL: the preview's Voice app").toBeTruthy();
  const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const slug = `voice-proof-${stamp}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Log in with Iterate" }).click({ noWaitAfter: true });
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(`${slug}@example.com`);
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  if (!(await password.isVisible()))
    await page.getByRole("button", { name: /^(Continue|Use password instead)$/ }).click();
  await password.fill(process.env.LOGIN_PASSWORD || "dev");
  // noWaitAfter: the post navigates; the next locator waits for it (the spinner-waiter counts a
  // navigation in flight as loading), not the click's tight action timeout
  await page.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
  await page
    .getByRole("textbox", { name: "Organization name", exact: true })
    .fill("Voice rollout proof");
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(slug);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  await page.waitForURL(
    (url) => url.origin === new URL(baseURL!).origin && url.pathname === `/projects/${slug}`,
  );

  // A fresh project has no voice agent and no OpenAI key, so the page offers to install one. The
  // key is only stored: health answers without calling OpenAI.
  await page.getByLabel("OpenAI API key").fill("voice-spec-placeholder-key");
  await page.getByRole("button", { name: "Install voice", exact: true }).click();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();

  await page.reload();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();
  expect(errors).toEqual([]);
});
