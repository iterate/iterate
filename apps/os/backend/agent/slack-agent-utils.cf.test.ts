import { describe, expect, it } from "vitest";
import { getMentionedExternalUserIds, isBotMentionedInMessage } from "./slack-agent-utils.ts";

describe("slack-helpers mentions", () => {
  it("extracts user IDs from <@ID>", () => {
    const text = "Hello <@U12345> and <@U67890>";
    expect(getMentionedExternalUserIds(text)).toEqual(["U12345", "U67890"]);
  });

  it("extracts user IDs from <@ID|name>", () => {
    const text = "Ping <@U096V5ACXD0|iterate_ci_preview> please";
    expect(getMentionedExternalUserIds(text)).toEqual(["U096V5ACXD0"]);
  });

  it("handles mixed mention formats", () => {
    const text = "<@U00001|alice> meet <@U00002>";
    expect(getMentionedExternalUserIds(text)).toEqual(["U00001", "U00002"]);
  });

  it("isBotMentionedInMessage returns true when bot is mentioned (plain)", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "message",
      text: `Reminder: ask <@${botId}> to tell a joke.`,
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(true);
  });

  it("isBotMentionedInMessage returns true when bot is mentioned (with name)", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "message",
      text: `Reminder: ask <@${botId}|iterate_ci_preview> to tell a joke.`,
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(true);
  });

  it("isBotMentionedInMessage returns false when no mentions", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "message",
      text: `No mentions here`,
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(false);
  });

  it("isBotMentionedInMessage returns false for messages from the bot itself", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "message",
      text: `Hi <@${botId}>`,
      user: botId,
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(false);
  });

  it("isBotMentionedInMessage returns true for app_mention events", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "app_mention",
      text: `Hey <@${botId}> can you help?`,
      user: "U12345",
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(true);
  });

  it("isBotMentionedInMessage returns false for app_mention from bot itself", () => {
    const botId = "U096V5ACXD0";
    const event = {
      type: "app_mention",
      text: `Hey <@${botId}>`,
      user: botId,
      channel: "C123",
      ts: "1",
    };
    expect(isBotMentionedInMessage(event, botId)).toBe(false);
  });
});
