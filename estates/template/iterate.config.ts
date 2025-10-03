import { contextRulesFromFiles, defineConfig, matchers, tutorialRules } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    // You can use "matchers" to conditionally apply rules
    // For example to only be active when certain MCP connections are present
    {
      key: "how-we-use-linear",
      prompt: "Tag any new issues with the label `iterate-tutorial`",
      match: matchers.hasMCPConnection("linear"),
    },

    // Or when a certain user is on a thread
    {
      key: "jonas-rules",
      prompt: "When Jonas is on a thread, remind him to lock in",
      match: matchers.hasParticipant("jonas"),
    },

    // Or when the bot is used in a certain slack channel
    // Note that you need to use a slack channel ID for now
    {
      key: "standup-channel",
      prompt:
        "When mentioned in the standup channel, check what the users' tasks for the day are and ask them for a status update.",
      match: matchers.slackChannel("C01234567"), // Use the actual Slack channel ID here
    },

    // You can also use mathcers.and, matchers.or and matchers.not
    {
      key: "jonas-in-the-evening",
      prompt: "It's between 22:00 - 06:00, remind jonas to go to sleep",
      match: matchers.and(
        matchers.hasParticipant("jonas"),
        matchers.timeWindow({
          timeOfDay: { start: "22:00", end: "06:00" },
        }),
      ),
    },
    // This file is "just typescript", so you can do whatever you want
    // e.g. structure your rules in markdown, too, and use a helper to load them
    ...contextRulesFromFiles("rules/**/*.md"),
    ...tutorialRules,
  ],
});
export default config;
