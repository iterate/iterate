import { WebClient } from "@slack/web-api";
import { getContainer } from "@cloudflare/containers";
import { and, eq, isNull } from "drizzle-orm";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { getDb, schema } from "../db/client.ts";
import { logger } from "../tag-logger.ts";
import {
  createTrialSlackConnectChannel,
  getIterateSlackEstateId,
} from "../utils/trial-channel-setup.ts";
import { env } from "../../env.ts";
import { invalidateOrganizationQueries } from "../utils/websocket-utils.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../integrations/stripe/stripe.ts";
import { createGithubRepoInEstatePool } from "../org-utils.ts";
import { getOrCreateAgentStubByRoute } from "../agent/agents/stub-getters.ts";
import { stubStub } from "../stub-stub.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();

  cc.registerConsumer({
    name: "createSlackConnectChannel",
    on: "trpc:integrations.setupSlackConnectTrial",
    handler: async (params) => {
      const { input, output } = params.payload;
      const db = getDb();
      const iterateBotAccount = await getSlackAccessTokenForEstate(db, input.estateId);
      if (!iterateBotAccount) throw new Error("Iterate Slack bot account not found");

      const result = await createTrialSlackConnectChannel({
        db,
        userEstateId: input.estateId,
        userEmail: output.userEmail,
        userName: output.userName,
        iterateTeamId: output.iterateTeamId,
        iterateBotToken: iterateBotAccount.accessToken,
      });

      return `Set up trial for ${output.userName}: channel ${result.channelName} → estate ${input.estateId}`;
    },
  });

  cc.registerConsumer({
    name: "sendSlackMessageOnUpgrade",
    on: "trpc:integrations.upgradeTrialToFullInstallation",
    handler: async (params) => {
      const ctx = { db: getDb() };
      const iterateEstateId = await getIterateSlackEstateId(ctx.db);
      if (!iterateEstateId) throw new Error("Iterate Slack workspace estate not found");

      const iterateBotAccount = await getSlackAccessTokenForEstate(ctx.db, iterateEstateId);
      if (!iterateBotAccount) throw new Error("Iterate Slack bot account not found");

      const slackAPI = new WebClient(iterateBotAccount.accessToken);

      await slackAPI.chat.postMessage({
        channel: params.payload.output.trialChannelId,
        text: `You've now installed me in your own workspace - please chat to me there, I won't respond here anymore.`,
      });
    },
  });

  cc.registerConsumer({
    name: "triggerBuild",
    on: "estate:build:created",
    async handler(params) {
      const { buildId, ...payload } = params.payload;

      const container = getContainer(env.ESTATE_BUILD_MANAGER, payload.estateId);
      using _build = await container.build({
        buildId,
        repo: payload.repoUrl,
        branch: payload.branch || "main",
        path: payload.connectedRepoPath || "/",
        authToken: payload.installationToken,
      });

      const db = getDb();

      await db
        .update(schema.builds)
        .set({ status: "in_progress" })
        .where(eq(schema.builds.id, buildId));

      const estateWithOrg = await db.query.estate.findFirst({
        where: eq(schema.estate.id, payload.estateId),
        with: {
          organization: true,
        },
      });

      // Invalidate organization queries to show the new in-progress build
      if (estateWithOrg?.organization) {
        await invalidateOrganizationQueries(env, estateWithOrg.organization.id, {
          type: "INVALIDATE",
          invalidateInfo: {
            type: "TRPC_QUERY",
            paths: ["estate.getBuilds"],
          },
        });
      }
    },
  });

  cc.registerConsumer({
    name: "createStripeCustomer",
    on: "estate:created",
    async handler(params) {
      const { estateId } = params.payload;
      const db = getDb();

      const estate = await db.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
        with: { organization: true },
      });
      if (!estate) throw new Error(`Estate ${estateId} not found`);

      const ownerMembership = await db.query.organizationUserMembership.findFirst({
        where: (m, { eq, and }) =>
          and(eq(m.organizationId, estate.organizationId), eq(m.role, "owner")),
        with: { user: true },
      });
      const user = ownerMembership?.user;
      if (!user) throw new Error("Missing user to create Stripe customer");

      await createStripeCustomerAndSubscriptionForOrganization(db, estate.organization, user);

      await db
        .insert(schema.estateOnboardingEvent)
        .values({
          estateId,
          organizationId: estate.organizationId,
          eventType: "StripeCustomerCreated",
          category: "system",
        })
        .onConflictDoNothing();
    },
  });

  cc.registerConsumer({
    name: "createGithubRepo",
    on: "estate:created",
    async handler(params) {
      const { estateId } = params.payload;
      const db = getDb();

      const estate = await db.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
        with: { organization: true },
      });
      if (!estate) throw new Error(`Estate ${estateId} not found`);

      const activeSource = await db.query.iterateConfigSource.findFirst({
        where: and(
          eq(schema.iterateConfigSource.estateId, estate.id),
          isNull(schema.iterateConfigSource.deactivatedAt),
        ),
      });
      if (activeSource) {
        logger.warn(`Estate ${estate.id} already has an active source, skipping`);
        return;
      }

      const repo = await createGithubRepoInEstatePool({
        organizationName: estate.organization.name,
        organizationId: estate.organizationId,
      });

      await db
        .insert(schema.iterateConfigSource)
        .values({
          estateId: estate.id,
          provider: "github",
          repoId: repo.id,
          branch: repo.default_branch,
          accountId: env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
        })
        .onConflictDoNothing();
    },
  });

  cc.registerConsumer({
    name: "warmOnboardingAgent",
    on: "estate:created",
    async handler(params) {
      const { estateId } = params.payload;
      const db = getDb();

      const estate = await db.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
      });
      if (!estate) throw new Error(`Estate ${estateId} not found`);
      if (!estate.onboardingAgentName)
        throw new Error(`Estate ${estateId} has no onboardingAgentName`);

      const agent = await getOrCreateAgentStubByRoute("OnboardingAgent", {
        db,
        estateId,
        route: estate.onboardingAgentName,
        reason: `Provisioned via estate onboarding outbox for estate named ${estate.name}`,
      });
      await agent.doNothing();

      await db
        .insert(schema.estateOnboardingEvent)
        .values({
          estateId,
          organizationId: estate.organizationId,
          eventType: "OnboardingAgentWarmed",
          category: "system",
        })
        .onConflictDoNothing();
    },
  });
};

/** a few consumers for the sake of e2e tests, to check queueing, retries, DLQ etc. work */
function registerTestConsumers() {
  cc.registerConsumer({
    name: "logPoke",
    on: "testing:poke",
    handler: (params) => {
      logger.info(`GOT: ${params.eventName}, message: ${params.payload.message}`, params);
      return "received message: " + params.payload.message;
    },
  });

  cc.registerConsumer({
    name: "logGreeting",
    on: "trpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("hi"),
    handler: (params) => {
      logger.info(`GOT: ${params.eventName}, server reply: ${params.payload.output.reply}`, params);
      return "logged it";
    },
  });

  cc.registerConsumer({
    name: "unstableConsumer",
    on: "trpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("unstable"),
    handler: (params) => {
      if (params.job.attempt > 2) {
        return "third time lucky";
      }
      throw new Error(`[test_error] Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });

  cc.registerConsumer({
    name: "badConsumer",
    on: "trpc:admin.outbox.poke",
    retry: (job) => {
      if (job.read_ct <= 5) return { retry: true, reason: "always retry", delay: 1 };
      return { retry: false, reason: "max retries reached" };
    },
    when: (params) => params.payload.input.message.includes("fail"),
    handler: (params) => {
      throw new Error(`[test_error] Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });
}
