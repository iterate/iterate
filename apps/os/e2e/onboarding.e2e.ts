import { test, expect, vi } from "vitest";
import { createE2EHelper } from "./helpers.ts";

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
  await using h = await createE2EHelper("onboarding-e2e");
  const { adminTrpc, userTrpc, estate, estateId } = h;
  await adminTrpc.testing.cleanupOutbox.mutate();
  const foundRepo = await vi.waitUntil(
    async () => {
      const [first] = await userTrpc.integrations.listAvailableGithubRepos.query({ estateId });
      return first;
    },
    { interval: 1000, timeout: 10_000 },
  );
  expect(foundRepo, "(a github repo should be available)").toBeDefined();
  h.onDispose(async () => {
    if (!foundRepo?.full_name) return;
    await adminTrpc.testing.deleteIterateManagedRepo.mutate({ repoFullName: foundRepo.full_name });
  });

  console.log(`Found repository in available repos: ${foundRepo?.full_name}`);

  // Wait for the GitHub template repo to be fully created (branch may not be immediately available)
  await vi.waitUntil(
    async () => {
      try {
        await userTrpc.estate.triggerRebuild.mutate({
          estateId,
          target: "main",
          useExisting: true,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Branch not found") || message.includes("Not Found")) {
          console.log("Waiting for main branch to be available...");
          return false;
        }
        throw error;
      }
    },
    { interval: 2000, timeout: 60_000 },
  );

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
    .not.toMatchObject({ status: expect.stringMatching(/in_progress|queued/i) }); // give it a few minutes to get out of "queued" or "in_progress"

  // now that it's not in progress, it *must* be complete
  expect(await getLatestBuild()).toMatchObject({ status: "complete" });

  console.log("Build completed successfully");

  const msg = await h.sendUserMessage("Hello from E2E test");

  const reply = await msg.waitForReply();
  expect(reply).toMatch(/.+/); // any string reply is ok
});
