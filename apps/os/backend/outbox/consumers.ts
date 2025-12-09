import { WebClient } from "@slack/web-api";
import { getContainer } from "@cloudflare/containers";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { getDb } from "../db/client.ts";
import { logger } from "../tag-logger.ts";
import {
  createTrialSlackConnectChannel,
  getIterateSlackEstateId,
} from "../utils/trial-channel-setup.ts";
import { env } from "../../env.ts";
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
