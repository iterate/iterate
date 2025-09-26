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
        .describe(
          "Whether to unfurl links and media. If auto, unfurls links and media when and only when there is exactly 1 link in the message.",
        ),
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
  uploadAndShareFileInSlack: {
    description:
      "Upload and share a file with all users in the current Slack conversation with rich preview/unfurling",
    input: z.object({
      iterateFileId: z.string().describe("The Iterate file ID to upload"),
      // If you allow the agent to provide a comment with the file, it will say something like "here's your file",
      // and then again sendSlackMessage({ text: "here's your file", endTurn: true })
      // TODO: Find a better solution to that prompting issue that doens't take away the ability to provide a comment with the file
      // initialComment: z.string().optional().describe("Optional comment to include with the file"),
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
});
