import { test, expect } from "vitest";
import { z } from "zod/v4";
import { WebClient } from "@slack/web-api";
import { Octokit } from "octokit";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";
import { E2ETestParams } from "./utils/test-helpers/onboarding-test-schema.ts";

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
 *
 * Prerequisites:
 * - GitHub App must be installed for the test organization
 * - ONBOARDING_E2E_TEST_SETUP_PARAMS must include valid GitHub installation credentials
 * - Slack bot must be installed in the test workspace
 * - ONBOARDING_E2E_TEST_SETUP_PARAMS must include valid Slack bot and user tokens
 */

// Environment variables schema
const TestEnv = z.object({
  VITE_PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  ONBOARDING_E2E_TEST_SETUP_PARAMS: z.string().transform((val) => JSON.parse(val)),
});

type E2ETestParams = z.infer<typeof E2ETestParams>;

// Helper to generate unique test repository name
function generateRepoName() {
  return `estate-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

test.skipIf(!process.env.VITEST_RUN_ONBOARDING_TEST)(
  "end-to-end onboarding flow",
  {
    timeout: 15 * 60 * 1000, // 15 minutes total timeout
  },
  async () => {
    // Parse and validate environment
    const env = TestEnv.parse({
      VITE_PUBLIC_URL: process.env.VITE_PUBLIC_URL,
      SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
      ONBOARDING_E2E_TEST_SETUP_PARAMS: process.env.ONBOARDING_E2E_TEST_SETUP_PARAMS,
    });

    const testSeedData = E2ETestParams.parse(env.ONBOARDING_E2E_TEST_SETUP_PARAMS);
    const repoName = generateRepoName();
    let createdRepoFullName: string | null = null;
    let createdUserEmail: string | null = null;
    let adminTrpc: ReturnType<typeof makeVitestTrpcClient> | null = null;
    try {
      // Step 1: Create authenticated TRPC client using service auth
      console.log("Step 1: Authenticating with service auth token...");

      if (!env.SERVICE_AUTH_TOKEN) {
        throw new Error("SERVICE_AUTH_TOKEN environment variable is required");
      }

      // Use service auth to get session for super user
      const serviceAuthResponse = await fetch(
        `${env.VITE_PUBLIC_URL}/api/auth/service-auth/create-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            serviceAuthToken: env.SERVICE_AUTH_TOKEN,
          }),
        },
      );

      if (!serviceAuthResponse.ok) {
        const error = await serviceAuthResponse.text();
        throw new Error(`Failed to authenticate with service auth: ${error}`);
      }

      const sessionCookies = serviceAuthResponse.headers.get("set-cookie");
      if (!sessionCookies) {
        throw new Error("Failed to get session cookies from service auth");
      }

      console.log("Successfully authenticated");

      // Step 2: Setup test onboarding user (create organization and estate)
      console.log("Step 2: Setting up test user with organization and estate...");

      adminTrpc = makeVitestTrpcClient({
        url: `${env.VITE_PUBLIC_URL}/api/trpc`,
        headers: {
          cookie: sessionCookies,
        },
      });

      const testData = await adminTrpc.admin.setupTestOnboardingUser.mutate();
      if (!testData) {
        throw new Error("Failed to setup test user with organization and estate");
      }
      const { user, organization, estate, hasSeedData } = testData;
      createdUserEmail = user.email;
      console.log(`Created test user: ${user.email} (${user.id})`);
      console.log(`Created organization: ${organization.name} (${organization.id})`);
      console.log(`Created estate: ${estate.name} (${estate.id})`);
      console.log(`Has seed data: ${hasSeedData}`);

      // Step 3: Impersonate the test user
      console.log("Step 3: Impersonating test user...");

      const authClient = createAuthClient({
        baseURL: env.VITE_PUBLIC_URL,
        plugins: [adminClient()],
      });

      let impersonationCookies = "";

      const impersonationResult = await authClient.admin.impersonateUser(
        {
          userId: user.id,
        },
        {
          headers: {
            cookie: sessionCookies,
          },
          onResponse(context: { response: Response }) {
            const cookies = context.response.headers.getSetCookie();
            const cookieObj = Object.fromEntries(cookies.map((cookie) => cookie.split("=")));
            if (cookieObj) {
              impersonationCookies = Object.entries(cookieObj)
                .map(([key, value]) => `${key}=${value}`)
                .join("; ");
            }
          },
        },
      );

      if (!impersonationResult?.data) {
        throw new Error("Failed to impersonate user");
      }

      if (!impersonationCookies) {
        throw new Error("Failed to get impersonation cookies");
      }

      console.log("Successfully impersonated test user");

      // Note: GitHub installation linking would normally happen through the OAuth callback

      // Step 4: Clone estate-template and push to new repository
      console.log("Step 5: Cloning estate-template repository...");

      const octokit = new Octokit({
        auth: testSeedData.github.accessToken,
      });

      // Generate new repository from template
      const templateOwner = "iterate";
      const templateRepo = "estate-template";

      const newRepoResponse = await octokit.rest.repos.createUsingTemplate({
        template_owner: templateOwner,
        template_repo: templateRepo,
        owner: "iterate-estates",
        name: repoName,
        private: false,
        description: "E2E test estate repository",
      });

      if (newRepoResponse.status !== 201) {
        throw new Error(`Failed to create repository: ${JSON.stringify(newRepoResponse)}`);
      }

      const newRepo = newRepoResponse.data;
      createdRepoFullName = newRepo.full_name;
      console.log(`Created repository from template: ${createdRepoFullName}`);

      // Wait a bit for GitHub to process the new repository
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create TRPC client with impersonated user session
      const userTrpc = makeVitestTrpcClient({
        url: `${env.VITE_PUBLIC_URL}/api/trpc`,
        headers: {
          cookie: impersonationCookies,
        },
      });

      // Step 5: List available GitHub repos and verify our new repo is there
      console.log(
        `Step 6: Listing available GitHub repositories using ${env.VITE_PUBLIC_URL}/api/trpc endpoint`,
      );

      const availableRepos = await userTrpc.integrations.listAvailableGithubRepos.query({
        estateId: estate.id,
      });

      const foundRepo = availableRepos.find((repo) => repo.full_name === createdRepoFullName);

      expect(foundRepo).toBeDefined();
      console.log(`Found repository in available repos: ${foundRepo?.full_name}`);

      // Link the repository
      console.log("Step 7: Linking repository to estate...");

      if (!foundRepo) {
        throw new Error(`Repository ${createdRepoFullName} not found in available repos`);
      }

      await userTrpc.integrations.setGithubRepoForEstate.mutate({
        estateId: estate.id,
        repoId: foundRepo.id,
        path: "/",
        branch: "main",
      });

      console.log("Repository linked successfully");

      // Step 6: Poll for build completion
      console.log("Step 8: Waiting for initial build to complete...");

      const buildTimeout = 5 * 60 * 1000; // 5 minutes
      const pollInterval = 5000; // 5 seconds

      const getLatestBuild = async () => {
        const builds = await userTrpc.estate.getBuilds.query({
          estateId: estate.id,
          limit: 1,
        });
        console.log(`Latest build status: ${builds[0]?.status} (${builds[0]?.id})`);
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

      // Step 7: Send message to Slack
      console.log("Step 9: Sending message to Slack...");

      const slackUserClient = new WebClient(testSeedData.slack.user.accessToken);

      const messageResult = await slackUserClient.chat.postMessage({
        channel: testSeedData.slack.targetChannelId,
        text: `Hello from E2E test  <@${testSeedData.slack.bot.id}>!`,
      });

      if (!messageResult.ok || !messageResult.ts) {
        throw new Error("Failed to send Slack message");
      }

      const messageTs = messageResult.ts;
      console.log(`Sent message to Slack (ts: ${messageTs})`);

      // Step 8: Wait for bot reply in thread
      console.log("Step 10: Waiting for bot reply...");

      const replyTimeout = 2 * 60 * 1000; // 2 minutes
      const replyPollInterval = 3000; // 3 seconds

      const slackBotClient = new WebClient(testSeedData.slack.bot.accessToken);

      await expect
        .poll(
          async () => {
            console.log("Polling for replies...");
            const replies = await slackBotClient.conversations
              .replies({
                channel: testSeedData.slack.targetChannelId,
                ts: messageTs,
              })
              .catch((error) => {
                console.error("Failed to get replies:", error);
                throw error;
              });

            if (!replies.ok || !replies.messages) {
              return [];
            }

            // Filter out the original message and get replies from bot
            const botReplies = replies.messages.filter(
              (msg) => msg.ts !== messageTs && msg.user === testSeedData.slack.bot.id,
            );
            return botReplies;
          },
          {
            timeout: replyTimeout,
            interval: replyPollInterval,
          },
        )
        .toSatisfy((replies) => replies.length > 0);

      console.log("✅ Bot replied successfully!");
      console.log("End-to-end test completed successfully!");
    } finally {
      // Cleanup: Delete the created repository
      if (createdRepoFullName) {
        console.log(`Cleaning up: Deleting repository ${createdRepoFullName}...`);

        try {
          const octokit = new Octokit({
            auth: testSeedData.github.accessToken,
          });

          const [owner, repo] = createdRepoFullName.split("/");
          await octokit.rest.repos.delete({
            owner,
            repo,
          });

          console.log(`Repository ${createdRepoFullName} deleted successfully`);
        } catch (error) {
          console.error(`Failed to delete repository: ${error}`);
          // Don't fail the test if cleanup fails
        }
        if (createdUserEmail && adminTrpc) {
          console.log(`Cleaning up: Deleting user ${createdUserEmail}...`);
          await adminTrpc.admin.deleteUserByEmail.mutate({ email: createdUserEmail });
          console.log(`User ${createdUserEmail} deleted successfully`);
        }
      }
    }
  },
);
