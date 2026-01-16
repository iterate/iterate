import { login, test, createOrganization, sidebarButton, toast } from "./test-helpers.ts";

test.describe("organization invites", () => {
  test("owner can invite and cancel an invite from team page", async ({ page }) => {
    const timestamp = Date.now();
    const ownerEmail = `invite-owner-${timestamp}+test@nustom.com`;
    const inviteeEmail = `invite-user-${timestamp}+test@nustom.com`;

    await login(page, ownerEmail);
    await createOrganization(page);

    // Go to team page and invite user
    await sidebarButton(page, "Team").click();
    await page.getByLabel("Invite by email").fill(inviteeEmail);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await toast.success(page, "Invite sent").waitFor();

    // Verify invite appears in pending list
    await page.getByText(inviteeEmail).waitFor();
    await page.getByText("Pending invite").waitFor();

    // Cancel the invite (X button in the row)
    const inviteRow = page.getByRole("row").filter({ hasText: inviteeEmail });
    await inviteRow.getByRole("button").click();
    await toast.success(page, "Invite cancelled").waitFor();

    // Verify invite is gone
    await page.getByText(inviteeEmail).waitFor({ state: "hidden" });
  });

  test("pending invites show on org home page", async ({ page }) => {
    const timestamp = Date.now();
    const ownerEmail = `home-owner-${timestamp}+test@nustom.com`;
    const inviteeEmail = `home-user-${timestamp}+test@nustom.com`;

    await login(page, ownerEmail);
    await createOrganization(page);

    // Set up dialog handler before clicking
    page.on("dialog", (dialog) => dialog.accept(inviteeEmail));

    // Invite from org home page using prompt
    await page.getByRole("button", { name: "Invite member" }).click();
    await toast.success(page, "Invite sent").waitFor();

    // Verify invite shows in Team section
    await page.getByText(inviteeEmail).waitFor();
    await page.getByText("Pending invite").waitFor();

    // Can cancel from here too
    const inviteItem = page.locator("[data-slot='item']").filter({ hasText: inviteeEmail });
    await inviteItem.getByRole("button").click();
    await toast.success(page, "Invite cancelled").waitFor();
    await page.getByText(inviteeEmail).waitFor({ state: "hidden" });
  });

  test("invitee sees pending invite on welcome page and can accept", async ({ page }) => {
    const timestamp = Date.now();
    const ownerEmail = `accept-owner-${timestamp}+test@nustom.com`;
    const inviteeEmail = `accept-user-${timestamp}+test@nustom.com`;
    const orgName = `Accept Test Org ${timestamp}`;

    // Owner creates org and sends invite
    await login(page, ownerEmail);
    await createOrganization(page, orgName);

    await sidebarButton(page, "Team").click();
    await page.getByLabel("Invite by email").fill(inviteeEmail);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await toast.success(page, "Invite sent").waitFor();

    // Log out via UI
    await page.getByRole("button", { name: ownerEmail }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.getByTestId("email-input").waitFor();

    // Invitee logs in and sees the pending invite
    await login(page, inviteeEmail);

    // Should be on welcome page with pending invite
    await page.getByText("Welcome to Iterate").waitFor();
    await page.getByText(orgName).waitFor();
    await page.getByRole("button", { name: "Accept" }).waitFor();

    // Accept the invite
    await page.getByRole("button", { name: "Accept" }).click();
    await toast.success(page, `Joined ${orgName}`).waitFor();

    // Should now be in the org
    await page.locator("[data-component='OrgSwitcher']", { hasText: orgName }).waitFor();
  });

  test("invitee can decline an invite", async ({ page }) => {
    const timestamp = Date.now();
    const ownerEmail = `decline-owner-${timestamp}+test@nustom.com`;
    const inviteeEmail = `decline-user-${timestamp}+test@nustom.com`;
    const orgName = `Decline Test Org ${timestamp}`;

    // Owner creates org and sends invite
    await login(page, ownerEmail);
    await createOrganization(page, orgName);

    await sidebarButton(page, "Team").click();
    await page.getByLabel("Invite by email").fill(inviteeEmail);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await toast.success(page, "Invite sent").waitFor();

    // Log out via UI
    await page.getByRole("button", { name: ownerEmail }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.getByTestId("email-input").waitFor();

    // Invitee logs in
    await login(page, inviteeEmail);

    await page.getByText(orgName).waitFor();

    // Click decline (X button next to Accept)
    const inviteItem = page.locator("[data-slot='item']").filter({ hasText: orgName });
    await inviteItem.getByRole("button").filter({ hasNotText: "Accept" }).click();
    await toast.success(page, "Invite declined").waitFor();

    // Invite should be gone, create org form still visible
    await page.getByText(orgName).waitFor({ state: "hidden" });
    await page.getByLabel("Organization name").waitFor();
  });
});
