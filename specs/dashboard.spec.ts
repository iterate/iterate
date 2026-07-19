import { createReusableAdminProject } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

test("can enter the dashboard with a forged session", async ({ baseURL, helpers, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  // This proves claim-to-dashboard routing, not project birth. Reuse a
  // generation-scoped deterministic project so marathon rounds skip redundant
  // bootstrap and a lost connection acknowledgement can be replayed safely.
  const project = await createReusableAdminProject({ baseUrl: baseURL, family: "dashboard" });
  await using fixture = await helpers.createFixture("dashboard", { project });

  await page.goto("/projects");
  await page.getByRole("link", { name: fixture.project.slug }).waitFor();
});
