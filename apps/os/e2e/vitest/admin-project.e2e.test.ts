import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

test("creates a disposable project through the admin oRPC client", async () => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });

  const found = await handle.client.projects.find({ id: handle.project.id });

  expect(found).toMatchObject({
    id: handle.project.id,
    slug: handle.project.slug,
  });
});
