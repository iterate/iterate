import { describe, expect, it } from "vitest";
import {
  getMentionedExternalUserIds,
  isBotMentionedInMessage,
  extractAllBotUserIdsFromAuthorizations,
} from "./slack-agent-utils.ts";
import type { SlackWebhookPayload } from "./slack.types.ts";

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

  describe("Multi-party Slack Connect scenarios", () => {
    it("isBotMentionedInMessage accepts array of bot IDs", () => {
      // Use realistic Slack user IDs (alphanumeric only, no underscores)
      const botIds = ["U01BOTA123", "U01BOTB456", "U01BOTC789"];
      const event = {
        type: "message",
        text: "Hey <@U01BOTB456> can you help?",
        channel: "C123",
        ts: "1",
      };
      expect(isBotMentionedInMessage(event, botIds)).toBe(true);
    });

    it("isBotMentionedInMessage returns true when any bot from array is mentioned", () => {
      // Realistic Slack user IDs for multi-workspace bots
      const botIds = ["U08UQSK9D2M", "U09LUUA74T1", "U0AWORKSPACE3"];

      // User mentions the bot from workspace A
      const eventMentionsA = {
        type: "message",
        text: "<@U08UQSK9D2M> hello",
        user: "U08GCBSPAG0",
        channel: "C01SHARED123",
        ts: "1",
      };
      expect(isBotMentionedInMessage(eventMentionsA, botIds)).toBe(true);

      // User mentions the bot from workspace C
      const eventMentionsC = {
        type: "message",
        text: "Question for <@U0AWORKSPACE3>",
        user: "U08GCBSPAG0",
        channel: "C01SHARED123",
        ts: "2",
      };
      expect(isBotMentionedInMessage(eventMentionsC, botIds)).toBe(true);
    });

    it("isBotMentionedInMessage returns false when no bot is mentioned", () => {
      const botIds = ["U01BOTA123", "U01BOTB456", "U01BOTC789"];
      const event = {
        type: "message",
        text: "Hello <@U012HUMAN999>",
        channel: "C123",
        ts: "1",
      };
      expect(isBotMentionedInMessage(event, botIds)).toBe(false);
    });

    it("isBotMentionedInMessage returns false for messages from any of the bots", () => {
      const botIds = ["U01BOTA123", "U01BOTB456", "U01BOTC789"];

      // Message from bot A mentioning bot B
      const eventFromBotA = {
        type: "message",
        text: "Hey <@U01BOTB456>",
        user: "U01BOTA123",
        channel: "C123",
        ts: "1",
      };
      expect(isBotMentionedInMessage(eventFromBotA, botIds)).toBe(false);

      // Message from bot C mentioning bot A
      const eventFromBotC = {
        type: "message",
        text: "<@U01BOTA123> ping",
        user: "U01BOTC789",
        channel: "C123",
        ts: "2",
      };
      expect(isBotMentionedInMessage(eventFromBotC, botIds)).toBe(false);
    });

    it("extractAllBotUserIdsFromAuthorizations returns all bot user IDs", () => {
      const payload: SlackWebhookPayload = {
        team_id: "T9N202C7N",
        authorizations: [
          { team_id: "T9N202C7N", user_id: "U08UQSK9D2M", is_bot: true },
          { team_id: "T01TEAMB456", user_id: "U09LUUA74T1", is_bot: true },
          { team_id: "T01TEAMC789", user_id: "U0AWORKSPACE3", is_bot: true },
        ],
      };

      const botIds = extractAllBotUserIdsFromAuthorizations(payload);
      expect(botIds).toEqual(["U08UQSK9D2M", "U09LUUA74T1", "U0AWORKSPACE3"]);
    });

    it("extractAllBotUserIdsFromAuthorizations filters out non-bot authorizations", () => {
      const payload: SlackWebhookPayload = {
        team_id: "T9N202C7N",
        authorizations: [
          { team_id: "T9N202C7N", user_id: "U08UQSK9D2M", is_bot: true },
          { team_id: "T01TEAMB456", user_id: "U012USER789", is_bot: false },
          { team_id: "T01TEAMC789", user_id: "U0AWORKSPACE3", is_bot: true },
        ],
      };

      const botIds = extractAllBotUserIdsFromAuthorizations(payload);
      expect(botIds).toEqual(["U08UQSK9D2M", "U0AWORKSPACE3"]);
    });

    it("extractAllBotUserIdsFromAuthorizations returns empty array when no authorizations", () => {
      const payload: SlackWebhookPayload = {
        team_id: "T9N202C7N",
      };

      const botIds = extractAllBotUserIdsFromAuthorizations(payload);
      expect(botIds).toEqual([]);
    });

    it("extractAllBotUserIdsFromAuthorizations handles missing user_id", () => {
      const payload: SlackWebhookPayload = {
        team_id: "T9N202C7N",
        authorizations: [
          { team_id: "T9N202C7N", user_id: "U08UQSK9D2M", is_bot: true },
          { team_id: "T01TEAMB456", is_bot: true }, // Missing user_id
          { team_id: "T01TEAMC789", user_id: "U0AWORKSPACE3", is_bot: true },
        ],
      };

      const botIds = extractAllBotUserIdsFromAuthorizations(payload);
      expect(botIds).toEqual(["U08UQSK9D2M", "U0AWORKSPACE3"]);
    });
  });
});
