import { expect, test } from "vitest";
import { createDisposer, createTestHelper, getAuthedTrpcClient } from "../evals/helpers.ts";

test("slack agent", { timeout: 15 * 60 * 1000 }, async () => {
  const { client: adminTrpc, impersonate } = await getAuthedTrpcClient();
  await using disposer = createDisposer();

  const { user: testUser } = await adminTrpc.testing.createTestUser.mutate({});
  disposer.fns.push(async () => {
    await adminTrpc.admin.deleteUserByEmail.mutate({ email: testUser.email });
  });

  const { organization } = await adminTrpc.testing.createOrganizationAndEstate.mutate({
    userId: testUser.id,
  });
  disposer.fns.push(async () => {
    await adminTrpc.testing.deleteOrganization.mutate({ organizationId: organization.id });
  });

  const { trpcClient: userTrpc } = await impersonate(testUser.id);

  const h = await createTestHelper({
    inputSlug: "slack-e2e",
    trpcClient: userTrpc,
  });

  const sent = await h.sendUserMessage("what is 1+2");
  const reply = await sent.waitForReply();
  expect(reply).toMatch(/3|three/i);
});
