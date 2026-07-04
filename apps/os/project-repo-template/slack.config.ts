/**
 * Configuration for the worker's Slack Web API surface (see `slack` in
 * worker.ts). Commit changes to this file to point the SDK at your workspace:
 * set `token` to a bot token, and leave `slackApiUrl` null for the real Slack
 * API (override it only for mocks or staging proxies).
 */
export const slackConfig: {
  slackApiUrl: string | null;
  token: string | null;
} = {
  slackApiUrl: null,
  token: null,
};
