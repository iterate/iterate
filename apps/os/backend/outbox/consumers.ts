import { logger } from "../tag-logger.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();
};

function registerTestConsumers() {
  cc.registerConsumer({
    name: "logPoke",
    on: "testing:poke",
    handler: (params) => {
      logger.info("Outbox test event", {
        eventName: params.eventName,
        message: params.payload.message,
      });
      return `received message: ${params.payload.message}`;
    },
  });
}
