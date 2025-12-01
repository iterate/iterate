import * as fs from "node:fs";
import { inspect } from "node:util";
import { test, expect } from "vitest";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { Octokit } from "octokit";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { eq } from "drizzle-orm";
import {
  createTestHelper,
  getAuthedTrpcClient,
  getImpersonatedTrpcClient,
  getServiceAuthCredentials,
} from "../evals/helpers.ts";
import { db } from "../sdk/cli/cli-db.ts";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";
import { E2ETestParams } from "./utils/test-helpers/onboarding-test-schema.ts";
import * as schema from "./db/schema.ts";
import { getOctokitForInstallation } from "./integrations/github/github-octokit-utils.ts";

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
  WORKER_URL: z.url(),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  ONBOARDING_E2E_TEST_SETUP_PARAMS: z
    .string()
    .transform((val) => JSON.parse(val))
    .pipe(E2ETestParams),
});

type E2ETestParams = z.infer<typeof E2ETestParams>;

const E2EEnv = z.object({
  SERVICE_AUTH_TOKEN: z.string().min(1),
  GITHUB_ESTATES_DEFAULT_INSTALLATION_ID: z.string().min(1),
});
const env = E2EEnv.parse(process.env);

const createDisposer = () => {
  const disposeFns: Array<() => Promise<void>> = [];
  return {
    add: (fn: () => Promise<void>) => disposeFns.push(fn),
    [Symbol.asyncDispose]: async () => {
      const errors: unknown[] = [];
      for (const fn of disposeFns) {
        await fn().catch((err) => errors.push(err));
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 0) throw new Error("Multiple disposers failed", { cause: errors });
    },
  };
};

test("onboardo", { timeout: 15 * 60 * 1000 }, async () => {
  const adminTrpc = await getAuthedTrpcClient();
  const disposer = createDisposer();

  const { user: testUser } = await adminTrpc.testing.createTestUser.mutate({});
  disposer.add(async () => {
    await adminTrpc.admin.deleteUserByEmail.mutate({ email: testUser.email });
  });

  const { estate, organization } = await adminTrpc.testing.createOrganizationAndEstate.mutate({
    userId: testUser.id,
  });
  disposer.add(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, organization.id));
    const leftovers = await db.query.estate.findMany({ where: eq(schema.estate.id, estate.id) });
    expect(leftovers).toHaveLength(0); // delete of org should cascade
  });

  const { sessionCookies: adminSessionCookies } = await getServiceAuthCredentials();

  const { trpcClient: userTrpc } = await getImpersonatedTrpcClient({
    userId: testUser.id,
    adminSessionCookes: adminSessionCookies,
  });

  const h = await createTestHelper({
    inputSlug: "onboarding-e2e",
    trpcClient: userTrpc,
  });

  const [foundRepo] = await userTrpc.integrations.listAvailableGithubRepos.query({
    estateId: estate.id,
  });
  expect(foundRepo).toBeDefined();
  disposer.add(async () => {
    if (!foundRepo?.full_name) return;
    const octokit = await getOctokitForInstallation(env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID);

    const [owner, repoName] = foundRepo.full_name.split("/");
    await octokit.rest.repos.delete({ owner, repo: repoName });
  });

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
  expect(reply).toMatch(/hey|hi|hello|how are you|can i help/i); // should really be an eval, maybe we just check there is some kind of a reply at all?
});

test(
  "end-to-end onboarding flow",
  { timeout: 15 * 60 * 1000 }, //
  async () => {
    const trpcLogs: unknown[][] = [];
    // Parse and validate environment
    const env = TestEnv.parse({
      WORKER_URL: process.env.WORKER_URL,
      SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
      ONBOARDING_E2E_TEST_SETUP_PARAMS: process.env.ONBOARDING_E2E_TEST_SETUP_PARAMS,
    } satisfies Partial<z.input<typeof TestEnv>>);
    const workerUrl = env.WORKER_URL;

    const testSeedData = env.ONBOARDING_E2E_TEST_SETUP_PARAMS;
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
      const serviceAuthResponse = await fetch(`${workerUrl}/api/auth/service-auth/create-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceAuthToken: env.SERVICE_AUTH_TOKEN }),
      });

      if (!serviceAuthResponse.ok) {
        const error = await serviceAuthResponse.text();
        const headers = inspect(serviceAuthResponse.headers);
        throw new Error(
          `Failed to authenticate with service auth: ${error}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
        );
      }

      const sessionCookies = serviceAuthResponse.headers.get("set-cookie");
      if (!sessionCookies) {
        const text = await serviceAuthResponse.text();
        const headers = inspect(serviceAuthResponse.headers);
        throw new Error(
          `Failed to get session cookies from service auth. Response: ${text}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
        );
      }

      console.log("Successfully authenticated");

      // Step 2: Setup test onboarding user (create organization and estate)
      console.log("Step 2: Setting up test user with organization and estate...");

      adminTrpc = makeVitestTrpcClient({
        url: `${workerUrl}/api/trpc`,
        headers: { cookie: sessionCookies },
        log: (...args) => trpcLogs.push(["adminTrpc", ...args]),
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
        baseURL: workerUrl,
        plugins: [adminClient()],
      });

      let impersonationCookies = "";

      const impersonationResult = await authClient.admin.impersonateUser(
        { userId: user.id },
        {
          // Something changed in better-auth, so now we need to manually set the Origin header
          // most likely because we are calling this api from server-side which doesn't add the header
          // but better-auth expects it to be set
          headers: { cookie: sessionCookies, origin: env.WORKER_URL },
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
        throw new Error("Failed to impersonate user", { cause: impersonationResult });
      }

      if (!impersonationCookies) {
        throw new Error("Failed to get impersonation cookies", { cause: impersonationResult });
      }

      console.log("Successfully impersonated test user");

      // Step 4: Clone estate-template and push to new repository
      console.log("Step 5: Cloning estate-template repository...");

      // Create TRPC client with impersonated user session
      const userTrpc = makeVitestTrpcClient({
        url: `${workerUrl}/api/trpc`,
        headers: { cookie: impersonationCookies },
        log: (...args) => trpcLogs.push(["userTrpc", ...args]),
      });

      // Step 5: List available GitHub repos and verify our new repo is there
      console.log(`Step 6: Listing available GitHub repositories`);

      const [foundRepo] = await userTrpc.integrations.listAvailableGithubRepos.query({
        estateId: estate.id,
      });
      expect(foundRepo).toBeDefined();
      createdRepoFullName = foundRepo!.full_name;

      console.log(`Found repository in available repos: ${foundRepo?.full_name}`);

      console.log("Step 7: Waiting for initial build to complete...");

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
    } catch (error) {
      const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9\-.]+/g, "-");
      const file = `ignoreme/e2e-logs/${slugify(expect.getState().currentTestName!)}.json`;
      await fs.promises.mkdir("ignoreme/e2e-logs", { recursive: true });
      console.log(`Error occurred, writing trpc logs to file: ${file}`);
      await fs.promises.writeFile(file, JSON.stringify(trpcLogs, null, 2));
      throw error;
    } finally {
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
