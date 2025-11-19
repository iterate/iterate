import { createTrpcConsumer } from "../db/outbox/events.ts";
import { logger } from "../tag-logger.ts";
import type { appRouter } from "./root.ts";
import { queuer } from "./trpc.ts";

const cc = createTrpcConsumer<typeof appRouter, typeof queuer.$types.db>(queuer);

export const registerConsumers = () => {
  cc.registerConsumer({
    name: "logGreeting",
    on: "testing.testEventable",
    when: (params) => params.payload.input.message.includes("hi"),
    handler: (params) => {
      logger.info(`GOT: ${params.eventName} greeting: ${params.payload.output.greeting}`, params);
    },
  });
};
