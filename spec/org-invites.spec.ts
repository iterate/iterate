import { login, logout, test, createOrganization, sidebarButton, toast } from "./test-helpers.ts";

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

    await logout(page);

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

    await logout(page);

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

  test("user in org sees pending invites in user settings and can accept", async ({ page }) => {
    const timestamp = Date.now();
    const userEmail = `settings-user-${timestamp}+test@nustom.com`;
    const inviterEmail = `settings-inviter-${timestamp}+test@nustom.com`;
    const userOrgName = `User Org ${timestamp}`;
    const inviterOrgName = `Inviter Org ${timestamp}`;

    // User creates their own org first
    await login(page, userEmail);
    await createOrganization(page, userOrgName);
    await logout(page);

    // Inviter creates org and invites the user
    await login(page, inviterEmail);
    await createOrganization(page, inviterOrgName);

    await sidebarButton(page, "Team").click();
    await page.getByLabel("Invite by email").fill(userEmail);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await toast.success(page, "Invite sent").waitFor();

    await logout(page);

    // User logs back in - go directly to user settings
    await page.goto("/login");
    await page.getByTestId("email-input").fill(userEmail);
    await page.getByTestId("email-submit-button").click();
    await page.getByText("Enter verification code").waitFor();
    await page.locator('input[inputmode="numeric"]').first().focus();
    await page.keyboard.type("424242");

    // Wait for redirect to org, then navigate to settings
    await page.locator("[data-component='OrgSwitcher']").waitFor();
    await page.goto("/user/settings");

    await page.getByText("Pending invites").waitFor();
    await page.getByText(inviterOrgName).waitFor();

    // Accept the invite - find the card in the Pending invites section
    const pendingSection = page.locator("div").filter({ hasText: "Pending invites" }).first();
    const inviteCard = pendingSection
      .locator("div.border.rounded-lg")
      .filter({ hasText: inviterOrgName });
    await inviteCard.locator("button").first().click(); // Check icon button (accept)
    await toast.success(page, `Joined ${inviterOrgName}`).waitFor();

    // Should be redirected to the new org
    await page.locator("[data-component='OrgSwitcher']", { hasText: inviterOrgName }).waitFor();
  });

  test("user can leave an organization from user settings", async ({ page }) => {
    const timestamp = Date.now();
    const userEmail = `leave-user-${timestamp}+test@nustom.com`;
    const ownerEmail = `leave-owner-${timestamp}+test@nustom.com`;
    const orgName = `Leave Test Org ${timestamp}`;

    // Owner creates org and adds the user
    await login(page, ownerEmail);
    await createOrganization(page, orgName);

    await sidebarButton(page, "Team").click();
    await page.getByLabel("Invite by email").fill(userEmail);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await toast.success(page, "Invite sent").waitFor();

    await logout(page);

    // User accepts invite from welcome page
    await login(page, userEmail);
    await page.getByText(orgName).waitFor();
    await page.getByRole("button", { name: "Accept" }).click();
    await toast.success(page, `Joined ${orgName}`).waitFor();

    // Now leave the org from user settings
    await page.goto("/user/settings");
    await page.getByText("Organizations").waitFor();

    // Click leave button on the org card (LogOut icon button)
    const orgCard = page.locator("div.border.rounded-lg").filter({ hasText: orgName });
    await orgCard.locator("button").click();

    // Confirm in dialog
    await page.getByRole("dialog").getByRole("button", { name: "Leave" }).click();
    await toast.success(page, `Left ${orgName}`).waitFor();

    // Should be back on welcome page
    await page.getByText("Welcome to Iterate").waitFor();
  });

  test("sole owner cannot leave organization", async ({ page }) => {
    const timestamp = Date.now();
    const ownerEmail = `sole-owner-${timestamp}+test@nustom.com`;
    const orgName = `Sole Owner Org ${timestamp}`;

    await login(page, ownerEmail);
    await createOrganization(page, orgName);

    // Try to leave from user settings
    await page.goto("/user/settings");
    await page.getByText("Organizations").waitFor();

    // Click leave button on the org card (LogOut icon button)
    const orgCard = page.locator("div.border.rounded-lg").filter({ hasText: orgName });
    await orgCard.locator("button").click();

    // Confirm in dialog
    await page.getByRole("dialog").getByRole("button", { name: "Leave" }).click();

    // Should get error
    await toast.error(page, "Cannot leave organization as the only owner").waitFor();
  });
});
