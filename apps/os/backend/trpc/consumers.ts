import { createTrpcConsumer } from "../db/outbox/events.ts";
import { logger } from "../tag-logger.ts";
import type { appRouter } from "./root.ts";
import { queuer } from "./trpc.ts";

const cc = createTrpcConsumer<typeof appRouter, typeof queuer.$types.db>(queuer);

export const registerConsumers = () => {
  registerTestConsumers();
};

/** a few consumers for the sake of e2e tests, to check queueing, retries, DLQ etc. work */
function registerTestConsumers() {
  cc.registerConsumer({
    name: "logGreeting",
    on: "admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("hi"),
    handler: (params) => {
      logger.info(`GOT: ${params.eventName}, server reply: ${params.payload.output.reply}`, params);
      return "logged it";
    },
  });

  cc.registerConsumer({
    name: "unstableConsumer",
    on: "admin.outbox.poke",
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
    on: "admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("fail"),
    handler: (params) => {
      throw new Error(`Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });
}
