import { execSync } from "node:child_process";

import { WebClient } from "@slack/web-api";

export const slackChannelIds = {
  "#test-blank": "C08R1SMTZGD",
  "#misha-test": "C09B4EGQT7E",
  "#error-pulse": "C09K1CTN4M7",
  "#building": "C06LU7PGK0S",
  "#ci": "C0B3QJSU32A",
};

export const slackUsers = [
  {
    id: "U092YE019D5",
    handle: "nickblow",
    github: "nickblow",
  },
  {
    id: "U08V1A83Y2W",
    handle: "Rahul",
    github: "BlankParticle",
    oooUntil: new Date("2025-11-07T08:00:00Z"),
  },
  {
    id: "U099JH9TAF2",
    handle: "misha",
    github: "mmkal",
  },
  {
    id: "U067G4QRFK2",
    handle: "jonas",
    github: "jonastemplestein",
    oooUntil: new Date("2026-01-01"),
  },
];

export function resolveSlackChannel(channelName: string) {
  return slackChannelIds[channelName as keyof typeof slackChannelIds] ?? channelName;
}

export function getSlackBotToken() {
  if (process.env.SLACK_CI_BOT_TOKEN) {
    return process.env.SLACK_CI_BOT_TOKEN;
  }
  if (process.env.DOPPLER_TOKEN) {
    return execSync("doppler secrets --project _shared --config prd get --plain SLACK_CI_BOT_TOKEN")
      .toString()
      .trim();
  }
  throw new Error(
    "Can't get Slack bot token: neither SLACK_CI_BOT_TOKEN nor DOPPLER_TOKEN is available",
  );
}

export function getSlackClient(token = getSlackBotToken()) {
  return new WebClient(token);
}
