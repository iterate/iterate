import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { getDb } from "../db/client.ts";
import { createTrpcConsumer } from "../db/outbox/events.ts";
import { logger } from "../tag-logger.ts";
import { createTrialSlackConnectChannel } from "../utils/trial-channel-setup.ts";
import type { appRouter } from "./root.ts";
import { queuer } from "./trpc.ts";

const cc = createTrpcConsumer<typeof appRouter, typeof queuer.$types.db>(queuer);

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
};

/** a few consumers for the sake of e2e tests, to check queueing, retries, DLQ etc. work */
function registerTestConsumers() {
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
      throw new Error(`Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });

  cc.registerConsumer({
    name: "badConsumer",
    on: "trpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("fail"),
    handler: (params) => {
      throw new Error(`Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });
}
