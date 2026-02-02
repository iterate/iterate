import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";
import { getDb } from "../db/client.ts";
import { pokeRunningMachinesToRefresh } from "../utils/poke-machines.ts";
import { outboxClient as cc } from "./client.ts";

export function registerOAuthConsumers() {
  cc.registerConsumer({
    name: "handleGitHubConnectionCreated",
    on: "connection:github:created",
    handler: async ({ payload }) => {
      const { projectId } = payload;
      const db = getDb();

      logger.info("Processing GitHub connection created", { projectId });

      try {
        await pokeRunningMachinesToRefresh(db, projectId, env);
        logger.info("Poked machines after GitHub connection", { projectId });
        return "github_connection_processed";
      } catch (err) {
        logger.error("Failed to poke machines after GitHub connection", {
          projectId,
          err,
        });
        // Rethrow to trigger retry via outbox
        throw err;
      }
    },
  });

  cc.registerConsumer({
    name: "handleSlackConnectionCreated",
    on: "connection:slack:created",
    handler: async ({ payload }) => {
      const { projectId } = payload;
      const db = getDb();

      logger.info("Processing Slack connection created", { projectId });

      try {
        await pokeRunningMachinesToRefresh(db, projectId, env);
        logger.info("Poked machines after Slack connection", { projectId });
        return "slack_connection_processed";
      } catch (err) {
        logger.error("Failed to poke machines after Slack connection", {
          projectId,
          err,
        });
        // Rethrow to trigger retry via outbox
        throw err;
      }
    },
  });

  cc.registerConsumer({
    name: "handleGoogleConnectionCreated",
    on: "connection:google:created",
    handler: async ({ payload }) => {
      const { projectId } = payload;
      const db = getDb();

      logger.info("Processing Google connection created", { projectId });

      try {
        await pokeRunningMachinesToRefresh(db, projectId, env);
        logger.info("Poked machines after Google connection", { projectId });
        return "google_connection_processed";
      } catch (err) {
        logger.error("Failed to poke machines after Google connection", {
          projectId,
          err,
        });
        // Rethrow to trigger retry via outbox
        throw err;
      }
    },
  });
}
