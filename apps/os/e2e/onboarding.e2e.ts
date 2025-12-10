import { test, expect, vi } from "vitest";
import { createDisposer, createTestHelper, getAuthedTrpcClient } from "./helpers.ts";

/**
 * End-to-End Onboarding Test
 *
 * This test simulates a complete user onboarding flow:
 * 1. Authenticate with service auth token
 * 2. Create a test user and organization/estate
 * 3. Impersonate that user using better-auth admin SDK
 * 4. Clone the estate-template repo and push to a new repo
 * 5. Link the repository through the UI
 * 6. Wait for the initial build to complete
 * 7. Send a message to Slack
 * 8. Verify the bot responds
 * 9. Clean up the created repository
 */

test("onboarding", { timeout: 15 * 60 * 1000 }, async () => {
  const { client: adminTrpc, impersonate } = await getAuthedTrpcClient();
  await using disposer = createDisposer();

  const { user: testUser } = await adminTrpc.testing.createTestUser.mutate({});
  disposer.fns.push(async () => {
    await adminTrpc.admin.deleteUserByEmail.mutate({ email: testUser.email });
  });

  const { estate, organization } = await adminTrpc.testing.createOrganizationAndEstate.mutate({
    userId: testUser.id,
  });
  disposer.fns.push(async () => {
    await adminTrpc.testing.deleteOrganization.mutate({ organizationId: organization.id });
  });

  const { trpcClient: userTrpc } = await impersonate(testUser.id);

  const h = await createTestHelper({
    inputSlug: "onboarding-e2e",
    trpcClient: userTrpc,
  });

  const estateId = estate.id;
  const foundRepo = await vi.waitUntil(
    async () => {
      const [first] = await userTrpc.integrations.listAvailableGithubRepos.query({ estateId });
      return first;
    },
    { interval: 1000, timeout: 5000 },
  );
  expect(foundRepo, "(a github repo should be available)").toBeDefined();
  disposer.fns.push(async () => {
    if (!foundRepo?.full_name) return;
    await adminTrpc.testing.deleteIterateManagedRepo.mutate({ repoFullName: foundRepo.full_name });
  });

  // ideally we'd rely on the github webhook, but then this won't work outside of prod/staging
  await userTrpc.estate.triggerRebuild.mutate({ estateId, target: "main", useExisting: true });

  console.log(`Found repository in available repos: ${foundRepo?.full_name}`);

  console.log("Waiting for initial build to complete...");

  const buildTimeout = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 5000; // 5 seconds

  const getLatestBuild = async () => {
    const builds = await userTrpc.estate.getBuilds.query({
      estateId: estate.id,
      limit: 1,
    });
    console.log(
      `Latest build status: ${builds[0]?.status ?? "none"} (${builds[0]?.id ?? "<no-id>"})`,
    );
    return builds[0];
  };

  await expect
    .poll(getLatestBuild, { timeout: buildTimeout, interval: pollInterval })
    .toMatchObject({ status: expect.any(String) }); // make sure we get started fairly quickly

  await expect
    .poll(getLatestBuild, { timeout: buildTimeout, interval: pollInterval })
    .not.toMatchObject({ status: "in_progress" }); // give it a few minutes for "in_progress"

  // now that it's not in progress, it *must* be complete
  expect(await getLatestBuild()).toMatchObject({ status: "complete" });

  console.log("Build completed successfully");

  const msg = await h.sendUserMessage("Hello from E2E test");

  const reply = await msg.waitForReply();
  expect(reply).toMatch(/.+/); // any string reply is ok
});
