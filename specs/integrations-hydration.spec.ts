import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("hydrates the client-only integrations route without rebuilding the shell", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("integrations-hydration", {
    readiness: "core",
  });
  const hydrationErrors: Error[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("Hydration failed")) hydrationErrors.push(error);
  });

  await page.goto(`/projects/${fixture.project.slug}/integrations`);
  await page.getByRole("heading", { name: "Connectable integrations" }).waitFor();

  expect(hydrationErrors).toEqual([]);
});
