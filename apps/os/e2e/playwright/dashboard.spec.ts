import {
  createProject,
  expect,
  signInWithMintedOrg,
  test,
  uniqueSlug,
} from "./test-support/test.ts";

test("can enter the dashboard and create a project", async ({ page }) => {
  await signInWithMintedOrg(page);

  const projectSlug = uniqueSlug("playwright-project");
  await createProject(page, projectSlug);

  await expect(page).toHaveURL(new RegExp(`/projects/${projectSlug}/`));
  await expect(page.getByText(projectSlug).first()).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: projectSlug })).toBeVisible();
});
