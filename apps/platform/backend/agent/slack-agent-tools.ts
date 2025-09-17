// @ts-nocheck

import { z } from "zod";
import { defineDOTools } from "@iterate-com/helpers/agent/do-tools";
import { IntegrationMode } from "@iterate-com/sdk/tools";
import {
  AddSlackReactionInput,
  RemoveSlackReactionInput,
  SendSlackMessageInput,
  UpdateSlackMessageInput,
  UploadFileToSlackInput,
} from "../legacy-agent/integrations/slack/router.ts";
import type { StaticIntegrationSlug } from "../legacy-agent/integrations/manifests.ts";
import { SearchRequest } from "../legacy-agent/trpc/routes/default-tools.ts";
import { SlackInteractionPayload } from "./slack.types.ts";

export const slackAgentTools = defineDOTools({
  getSetupIntegrationInAgentURL: {
    description:
      "Setup an integration in the agent. Call with internal id for the user requesting the integration.",
    input: z.object({
      impersonateUserEmail: z.string(),
      mode: IntegrationMode,
      integrationSlug: z.string() as z.ZodType<StaticIntegrationSlug>,
      appSlug: z.string(),
    }),
  },
  onSlackWebhookEventReceived: {
    description: "Handle a Slack webhook event",
    input: z.unknown(),
  },
  onSlackInteractionReceived: {
    description: "Handle a Slack interaction event",
    input: z.object({
      payload: SlackInteractionPayload,
      interactionId: z.string(),
      timestamp: z.number(),
    }),
  },
  sendSlackMessage: {
    description: `Send a message to a Slack channel to a specific user. Supports rich formatting using blocks, buttons, and interactive elements for structured messages, forms, and other interactive components. Include modalDefinitions to define modals that open when buttons are clicked. Always set ephemeral=false!`,
    input: SendSlackMessageInput.extend({
      // make these both optional, because we can infer them from context (but still want to allow agents to send messages to other threads)
      channel: SendSlackMessageInput.shape.channel.optional(),
      threadTs: SendSlackMessageInput.shape.threadTs.optional(),
      endTurn: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Optional. Set this to end-turn only if you want to yield to the user and end your turn. For example because you've asked them for input on something or if you think you're done and there's nothing left for you to do.",
        ),
    }),
  },
  addSlackReaction: {
    description: "Add an emoji reaction to a Slack message",
    input: AddSlackReactionInput,
  },
  removeSlackReaction: {
    description: "Remove an emoji reaction from a Slack message",
    input: RemoveSlackReactionInput,
  },
  uploadAndShareFileInSlack: {
    description:
      "Upload and share a file with all users in the current Slack conversation with rich preview/unfurling",
    input: UploadFileToSlackInput.extend({
      // make these both optional, because we can infer them from context (but still want to allow agents to upload files to other threads)
      channel: z.string().optional(),
      threadTs: z.string().optional(),
    }),
  },
  createMemory: {
    description: "Create a memory",
    input: z.object({
      impersonateUserEmail: z.string(),
      content: z.string(),
      isEstateWide: z
        .boolean()
        .describe(
          "Whether everyone in the estate can see this memory or it is a personal memory for the current user",
        ),
    }),
  },
  updateSlackMessage: {
    description:
      "Update a message in a Slack channel. This is useful for updating the content of a message after it has been sent.",
    input: UpdateSlackMessageInput,
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
  getUrlContent: {
    description: "Get the content of a URL, including Slack message threads",
    input: z.object({
      url: z.string(),
      shouldMakeScreenshot: z
        .boolean()
        .describe(
          "Set to true to make a screenshot of the URL and make it visible to you. Set to false for file/image urls.",
        )
        .optional(),
    }),
  },
  searchWeb: {
    description: "Neural search the web",
    input: SearchRequest.omit({ type: true }),
  },
});
