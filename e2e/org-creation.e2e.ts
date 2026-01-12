import { login, createOrganization, test } from "./test-helpers.ts";

test.describe("organization creation flow", () => {
  test("should log in and create an organization", async ({ page, baseURL }) => {
    const testEmail = `test-e2e-${Date.now()}+test@nustom.com`;
    await login(page, testEmail, baseURL);
    await createOrganization(page);
  });
});
