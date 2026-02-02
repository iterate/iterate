import { logger } from "../tag-logger.ts";
import { outboxClient as cc } from "./client.ts";

export function registerOrganizationConsumers() {
  cc.registerConsumer({
    name: "handleOrganizationCreated",
    on: "organization:created",
    handler: async ({ payload }) => {
      const { organizationId, name, slug, createdByUserId } = payload;

      // Stub consumer for future automation
      // Future: send welcome email, setup default integrations, track org_created in PostHog, etc.
      logger.info("Organization created event processed", {
        organizationId,
        name,
        slug,
        createdByUserId,
      });

      return "organization_created_processed";
    },
  });
}
