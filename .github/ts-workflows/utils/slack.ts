import { execSync } from "child_process";
import { WebClient } from "@slack/web-api";

export const getSlackBotToken = () => {
  if (process.env.SLACK_CI_BOT_TOKEN) {
    return process.env.SLACK_CI_BOT_TOKEN;
  }
  const DOPPLER_TOKEN = process.env.DOPPLER_TOKEN;
  if (DOPPLER_TOKEN) {
    return execSync("doppler secrets --config prd get --plain SLACK_CI_BOT_TOKEN")
      .toString()
      .trim();
  }
  throw new Error(
    "Can't get Slack bot token: Neither SLACK_CI_BOT_TOKEN nor DOPPLER_TOKEN is available",
  );
};

export const getSlackClient = (token?: string) => new WebClient(token || getSlackBotToken());

export const slackChannelIds = {
  "#test-blank": "C08R1SMTZGD",
  "#misha-test": "C09B4EGQT7E",
  "#error-pulse": "C09K1CTN4M7",
  "#building": "C06LU7PGK0S",
};
