import { createProjectFixture } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

test("can enter the dashboard with a directly minted JWT session cookie", async ({
  baseURL,
  page,
}) => {
  await using projectFixture = await createProjectFixture("dashboard", { baseURL, page });

  await page.goto("/projects");
  await page.getByRole("link", { name: projectFixture.project.slug }).waitFor();
});
