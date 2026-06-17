import { createProject, signInWithLocalAuth, test, uniqueSlug } from "./test-support/test.ts";

test("can enter the dashboard and create a project", async ({ page }) => {
  await signInWithLocalAuth(page);

  const projectSlug = uniqueSlug("playwright-project");
  await createProject(page, projectSlug);

  await page.waitForURL(new RegExp(`/projects/${projectSlug}/`));
  await page.getByText(projectSlug).first().waitFor();

  await page.goto("/projects");
  await page.getByRole("link", { name: projectSlug }).waitFor();
});
