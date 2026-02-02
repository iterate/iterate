import { logger } from "../tag-logger.ts";
import { outboxClient as cc } from "./client.ts";

export function registerOAuthRefreshConsumers() {
  cc.registerConsumer({
    name: "handleOAuthTokenRefreshed",
    on: "oauth:token:refreshed",
    handler: async ({ payload }) => {
      const { secretId, connectorName, projectId } = payload;

      logger.info("OAuth token refreshed successfully", {
        secretId,
        connectorName,
        projectId,
      });

      // Future: Track success metrics, alert on repeated refresh patterns, etc.
      return "oauth_token_refreshed_logged";
    },
  });

  cc.registerConsumer({
    name: "handleOAuthTokenFailed",
    on: "oauth:token:failed",
    handler: async ({ payload }) => {
      const { secretId, connectorName, code, errorMessage, projectId } = payload;

      logger.error("OAuth token refresh failed", {
        secretId,
        connectorName,
        code,
        errorMessage,
        projectId,
      });

      // Future: Alert admins, track failure rates, trigger reauth notifications
      return "oauth_token_failure_logged";
    },
  });
}
