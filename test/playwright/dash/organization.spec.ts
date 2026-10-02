// The Dash's organization page (/organizations/<id>): the organization, its members and its open
// invitation links are the platform's catalog, read from `/api` (packages/dash
// components/organization-tree.tsx). A change made anywhere else lands a fact on the organization's
// own context, and the page reads again without a reload. The fixture's first project minted the
// organization, named after the email's local part (core/os src/control-plane/catalog.ts).
import { openOperatorSession } from "../../helpers/operator.ts";
import { test } from "../../helpers/test.ts";

test("an organization's page shows its members and when each joined, and follows a change made elsewhere without a reload: a member added, a link created, a rename", async ({
  page,
  baseURL,
  helpers,
  operator,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("org-page", { app: baseURL });
  const orgName = fixture.email.split("@")[0]!;
  // elsewhere: the owner's own session, which the operator opens as them
  using session = openOperatorSession();
  const owner = session.authenticate({ email: fixture.email });
  const [org] = await owner.organizations.list();
  const guest = `guest-${orgName}@example.com`;
  await operator.users.create({ email: guest });

  await page.goto(`/organizations/${org!.id}`);
  await page.getByRole("heading", { name: orgName, exact: true }).waitFor();
  await page.getByTestId("organization-member").filter({ hasText: fixture.email }).waitFor();

  // a change made elsewhere reaches the page as the organization's fact, landed after the verb
  // answers: no loading UI can show for a change the page does not know is coming
  await owner.organizations.addMember(org!.id, { userId: guest, role: "member" });
  await page.getByTestId("organization-member").filter({ hasText: guest }).waitFor({
    // timeout: a change made elsewhere, so the spinner-waiter has nothing to extend by
    timeout: 10_000,
  });
  // … since the moment the catalog recorded them joining
  const members = await owner.organizations.members(org!.id);
  const { createdAt } = members.find((member) => member.email === guest)!;
  await page
    .getByTestId("organization-member")
    .filter({ hasText: guest })
    .locator(`time[datetime="${new Date(createdAt!).toISOString()}"]`)
    .waitFor();

  await owner.organizations.createInvitation(org!.id, { emailHint: `invitee-${guest}` });
  await page
    .getByTestId("organization-invitation")
    .filter({ hasText: `invitee-${guest}` })
    // timeout: a change made elsewhere, so the spinner-waiter has nothing to extend by
    .waitFor({ timeout: 10_000 });

  await owner.organizations.rename(org!.id, { name: `Renamed ${orgName}` });
  await page.getByRole("heading", { name: `Renamed ${orgName}`, exact: true }).waitFor({
    // timeout: a change made elsewhere, so the spinner-waiter has nothing to extend by
    timeout: 10_000,
  });
});
