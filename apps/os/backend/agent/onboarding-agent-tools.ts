import z from "zod";
import { defineDOTools } from "./do-tools.ts";

export const onboardingAgentTools = defineDOTools({
  updateResults: {
    description:
      "Update the research results by merging the provided results into the existing research data.",
    statusIndicatorText: "📝 updating research results",
    input: z.object({
      results: z
        .record(z.string(), z.unknown())
        .describe("The research results to merge into existing data"),
    }),
  },
  getResults: {
    description: "Get the current research results stored in the agent state.",
    statusIndicatorText: "📖 retrieving research results",
    input: z.object({}),
  },
  startSlackThread: {
    description: "Start a new Slack thread with a Slack agent in the specified channel.",
    statusIndicatorText: "💬 starting Slack thread",
    input: z.object({
      channel: z.string().describe("The Slack channel ID where to start the thread"),
      firstMessage: z
        .string()
        .optional()
        .describe("Optional initial message to post in the thread"),
    }),
  },
  getOnboardingProgress: {
    description: "Check which onboarding steps the user has completed",
    statusIndicatorText: "📋 checking onboarding progress",
    input: z.object({}),
  },
  updateOnboardingProgress: {
    description: "Mark an onboarding step as complete or incomplete",
    statusIndicatorText: "✅ updating onboarding progress",
    input: z.object({
      step: z.enum([
        "firstToolConnected",
        "remoteMCPConnected",
        "learnedBotUsageEverywhere",
        "removedOnboardingRules",
        "stripeConnected",
        "communityInviteSent",
      ]).describe("The onboarding step to update"),
      completed: z.boolean().default(true).describe("Whether the step is completed (default: true)"),
    }),
  },
});
