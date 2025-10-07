import z from "zod";
import { defineDOTools } from "./do-tools.ts";

export const slackAgentTools = defineDOTools({
  sendSlackMessage: {
    description: `Send a slack message to the thread you are currently active in.`,
    input: z.object({
      text: z.string().describe("The message text (required if blocks not provided)"),
      blocks: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe("Array of slack block objects"),
      ephemeral: z
        .boolean()
        .optional()
        .describe(
          "Whether to send as ephemeral message (visible only to specific user). Requires 'user' field when true.",
        ),
      user: z
        .string()
        .optional()
        .describe("Slack user ID to send ephemeral message to (required when ephemeral=true)"),
      metadata: z
        .object({
          event_type: z.string(),
          event_payload: z.any(),
        })
        .optional()
        .describe("Optional metadata for tracking message events"),
      modalDefinitions: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Modal definitions for button interactions - maps action_id to modal view definition",
        ),
      unfurl: z
        .enum(["never", "auto", "all"])
        .default("auto")
        .optional()
        // If auto, unfurls links and media when and only when there is exactly 1 link in the message.
        .describe("Whether to unfurl links and media."),
      endTurn: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Optional. Set this to true only if you want to yield to the user and end your turn. For example because you've asked them for input on something or if you think you're done and there's nothing left for you to do.",
        ),
    }),
  },
  addSlackReaction: {
    description: "Add an emoji reaction to a Slack message",
    input: z.object({
      messageTs: z.string().describe("The ts of the message to react to"),
      name: z.string().describe("The emoji name (without colons, e.g., 'thumbsup')"),
    }),
  },
  removeSlackReaction: {
    description: "Remove an emoji reaction from a Slack message",
    input: z.object({
      messageTs: z.string().describe("The ts of the message to remove reaction from"),
      name: z.string().describe("The emoji name (without colons, e.g., 'thumbsup')"),
    }),
  },
  updateSlackMessage: {
    description:
      "Update a message in a Slack channel. This is useful for updating the content of a message after it has been sent.",
    input: z.object({
      ts: z.string().describe("The timestamp of the message to update"),
      text: z.string().optional().describe("Updated message text"),
      // blocks: z
      //   .array(z.record(z.string(), z.any()))
      //   .optional()
      //   .describe("Updated Block Kit blocks"),
      // metadata: z.any().optional().describe("Updated metadata"),
    }),
  },
  stopRespondingUntilMentioned: {
    description:
      "After you call this tool, you will not get a turn after any user messages, unless they explicitly mention you. Use this only when someone asks you to stop/ be quiet/enough/ shut-up, or reacts with 🤫/💤/🤐 to one of your messages. Or when you are explicitly asked to use it. This will cause you to add a zipper mouth emoji reaction to the most recent user message automatically (you don't need to do this)",
    input: z.object({
      reason: z
        .string()
        .describe(
          "Very short reason for why you want to disengage from this slack thread until mentioned. For example 'User X told me to shut up' or 'User Y responded with 🤫 to my message' or 'the conversation has moved on to a tangent i can't help with'",
        ),
    }),
  },
  searchSlackHistory: {
    description: "Search the Slack workspace for more context",
    input: z.object({
      query: z
        .string()
        .describe(
          'Full text search query to search Slack workspace. If more than one search term is provided, users and channels are also matched at a lower priority. To specifically search within a channel, group, or DM, add in:channel_name, in:group_name, or in:<@UserID>. To search for messages from a specific speaker, add from:<@UserID> or from:botname. For IM results, the type is set to "im" and the channel.name property contains the user ID of the target user. For private group results, type is set to "group". You can call this tool multiple times to search for more context in parallel.',
        ),
      sort: z
        .enum(["score", "timestamp"])
        .default("score")
        .describe("Sort results by score or timestamp"),
      sortDirection: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
      onBehalfOfIterateUserId: z
        .string()
        .describe("The Iterate user ID to search Slack workspace on behalf of"),
    }),
  },
  uploadAndShareFileInSlack: {
    description: "DO NOT USE - this is just here so old agents don't get bricked",
    input: z.object({
      iterateFileId: z.string().describe("The ID of the file to upload"),
    }),
  },
});
