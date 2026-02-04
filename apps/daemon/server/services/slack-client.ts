/**
 * Slack Client Service
 *
 * Provides a Slack WebClient for the daemon to send messages directly.
 * Used for backslash commands that respond immediately without involving the agent.
 */
import { WebClient } from "@slack/web-api";

let cachedClient: WebClient | null = null;

/**
 * Get a Slack WebClient instance.
 * Caches the client for reuse.
 */
export function getSlackClient(): WebClient {
  if (cachedClient) return cachedClient;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN environment variable is required");
  }

  cachedClient = new WebClient(token);
  return cachedClient;
}
