import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("hydrates the client-only reactivity route without rebuilding the shell", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("reactivity-hydration");
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto(`/projects/${fixture.project.slug}/reactivity`);
  await page.getByRole("heading", { name: "Live state playground" }).waitFor();

  expect(pageErrors).toEqual([]);
});
