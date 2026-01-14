import {
  login,
  test,
  createOrganization,
  createProject,
  sidebarButton,
  getOrganizationSlug,
  getProjectSlug,
} from "./test-helpers.ts";

test.describe("events page", () => {
  test("shows events from database", async ({ page }) => {
    const testEmail = `events-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    const pathname = new URL(page.url()).pathname;
    const orgSlug = getOrganizationSlug(pathname);
    const projectSlug = getProjectSlug(pathname);

    // Insert a test event via tRPC
    const eventType = `test:event-${Date.now()}`;
    await page.evaluate(
      async ({ orgSlug, projectSlug, eventType }) => {
        const response = await fetch("/api/trpc/testing.insertEvent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            json: {
              organizationSlug: orgSlug,
              projectSlug: projectSlug,
              type: eventType,
              payload: { test: true },
            },
          }),
        });
        if (!response.ok) throw new Error("Failed to insert event");
      },
      { orgSlug, projectSlug, eventType },
    );

    await sidebarButton(page, "Events").click();
    await page.getByText(eventType).waitFor();
  });
});
