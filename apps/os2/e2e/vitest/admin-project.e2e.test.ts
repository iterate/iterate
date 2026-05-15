import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

const hasAdminApiTarget =
  !!process.env.OS2_BASE_URL?.trim() &&
  !!(
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim()
  );
const testIfAdminApiTarget = hasAdminApiTarget ? test : test.skip;

testIfAdminApiTarget("creates a disposable project through the admin oRPC client", async () => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });

  const found = await handle.client.projects.find({ id: handle.project.id });

  expect(found).toMatchObject({
    id: handle.project.id,
    slug: handle.project.slug,
  });
});
