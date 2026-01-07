import { test, expect } from "@playwright/test";

test("can login, create org, create project, create machines, and archive one", async ({
  page,
}) => {
  const testId = Date.now();
  const email = `test${testId}+test@nustom.com`;

  await page.goto("/login");

  // Click "Continue with Email" to show the email form
  await page.getByRole("button", { name: "Continue with Email" }).click();

  // Fill in email and send OTP
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send OTP" }).click();

  // Wait for OTP form and fill it in (test emails use 424242)
  await page.getByLabel(/Enter OTP/i).fill("424242");
  await page.getByRole("button", { name: "Verify OTP" }).click();

  // Should redirect to home and show create org form
  await expect(page.getByRole("textbox", { name: "Organization name" })).toBeVisible();

  await page.getByRole("textbox", { name: "Organization name" }).fill("Test Org");
  await page.getByRole("button", { name: "Create Organization" }).click();

  await page.getByRole("button", { name: "Create Project" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("My Project");
  await page.getByRole("button", { name: "Create" }).click();

  await page.getByRole("button", { name: "Create Machine" }).click();
  await expect(page.getByText("started")).toBeVisible();

  await page.getByRole("button", { name: "New Machine" }).click();
  await expect(page.getByText("started")).toHaveCount(2);

  await page.getByRole("button", { name: "Archive" }).first().click();

  await expect(page.getByText("archived")).toBeVisible();
  await expect(page.getByText("started")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(1);
});
