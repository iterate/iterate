import { login, createOrganization, test } from "./test-helpers.ts";

test.describe("organization creation flow", () => {
  test("should log in and create an organization", async ({ page }) => {
    const testEmail = `spec-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
  });
});
