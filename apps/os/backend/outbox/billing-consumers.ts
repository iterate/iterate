import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { env } from "../../env.ts";
import { outboxClient as cc } from "./client.ts";

export function registerBillingConsumers() {
  cc.registerConsumer({
    name: "handleCheckoutInitiated",
    on: "billing:checkout:initiated",
    handler: async ({ payload }) => {
      const { organizationId, organizationSlug, userId, stripeCustomerId, checkoutSessionId } =
        payload;

      // Track checkout initiated in PostHog
      await captureServerEvent(env, {
        distinctId: `org:${organizationId}`,
        event: "checkout_initiated",
        properties: {
          checkout_session_id: checkoutSessionId,
          stripe_customer_id: stripeCustomerId,
          user_id: userId,
          organization_slug: organizationSlug,
        },
        groups: { organization: organizationId },
      });

      logger.info("Checkout initiated", {
        organizationId,
        checkoutSessionId,
        stripeCustomerId,
      });

      return "checkout_initiated";
    },
  });
}
