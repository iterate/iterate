import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { env } from "../../env.ts";
import { outboxClient as cc } from "./client.ts";

export function registerUserConsumers() {
  cc.registerConsumer({
    name: "handleUserCreated",
    on: "user:created",
    handler: async ({ payload }) => {
      const { userId, email, name, signupMethod } = payload;

      // Track user_signed_up event in PostHog
      await captureServerEvent(env, {
        distinctId: userId,
        event: "user_signed_up",
        properties: {
          signup_method: signupMethod,
          // $set creates/updates person properties so the event is linked to a person profile
          $set: {
            email,
            name,
          },
        },
      });

      logger.info("User created event processed", { userId, email });

      return "user_created_processed";
    },
  });
}
