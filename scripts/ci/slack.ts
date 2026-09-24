import { execSync } from "node:child_process";

import { WebClient } from "@slack/web-api";

export const slackChannelIds = {
  "#error-pulse": "C09K1CTN4M7",
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
  },
];

function getSlackBotToken() {
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

/** Who a page mentions: Jonas, on call for prd and main. */
export const onCallMention = `<@${slackUsers.find((user) => user.handle === "jonas")!.id}>`;

export function getSlackClient() {
  return new WebClient(getSlackBotToken());
}

/** Escapes the three characters Slack's mrkdwn treats as control characters. */
export function slackEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
