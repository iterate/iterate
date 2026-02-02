import { logger } from "../tag-logger.ts";
import { outboxClient as cc } from "./client.ts";
import { registerStripeConsumers } from "./stripe-consumers.ts";
import { registerSlackConsumers } from "./slack-consumers.ts";
import { registerResendConsumers } from "./resend-consumers.ts";

export const registerConsumers = () => {
  registerTestConsumers();
  registerStripeConsumers();
  registerSlackConsumers();
  registerResendConsumers();
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
}
