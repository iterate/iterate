import {
  addIterateSessionCookie,
  createAdminProject,
  mintIterateSession,
} from "./test-support/forged-session.ts";
import { expect, test, uniqueSlug } from "./test-support/test.ts";

test("project REPL accepts a directly minted JWT session cookie", async ({ baseURL, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  const projectSlug = uniqueSlug("forged-repl");
  await using projectFixture = await createAdminProject({ baseUrl: baseURL, slug: projectSlug });
  const organization = {
    id: `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: "Forged Playwright Org",
    role: "admin" as const,
    slug: uniqueSlug("forged-org"),
  };
  const session = await mintIterateSession({
    baseUrl: baseURL,
    email: `forged-${projectSlug}+test@nustom.com`,
    organizations: [organization],
    projects: [
      {
        id: projectFixture.project.id,
        organizationId: organization.id,
        slug: projectFixture.project.slug,
      },
    ],
  });

  await page.context().clearCookies();
  await addIterateSessionCookie({
    baseUrl: baseURL,
    context: page.context(),
    session,
  });

  await page.goto(`/projects/${projectFixture.project.slug}/repl`);
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.getByText("Result")).toBeVisible();
});
