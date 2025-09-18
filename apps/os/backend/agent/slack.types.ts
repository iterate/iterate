import { z } from "zod/v4";
import type { SlackEvent } from "@slack/types";

// Slack Interaction Payload Types
interface BaseSlackInteractionPayload {
  type: string;
  user: {
    id: string;
    username?: string;
    name?: string;
    team_id?: string;
  };
  team?: {
    id: string;
    domain?: string;
  };
  channel?: {
    id: string;
    name?: string;
  };
  trigger_id?: string;
  response_url?: string;
  token?: string;
}

interface BlockActionsPayload extends BaseSlackInteractionPayload {
  type: "block_actions";
  actions: Array<{
    action_id: string;
    type: string;
    value?: string;
    text?: {
      type: string;
      text: string;
    };
    selected_option?: {
      text: {
        type: string;
        text: string;
      };
      value: string;
    };
  }>;
  message?: {
    ts: string;
    thread_ts?: string;
    text?: string;
    user?: string;
  };
  container?: {
    channel_id?: string;
    thread_ts?: string;
    message_ts?: string;
  };
}

interface ViewSubmissionPayload extends BaseSlackInteractionPayload {
  type: "view_submission";
  view: {
    id: string;
    callback_id?: string;
    hash: string;
    title?: {
      type: string;
      text: string;
    };
    state?: {
      values: Record<string, Record<string, any>>;
    };
    private_metadata?: string;
  };
}

interface ViewClosedPayload extends BaseSlackInteractionPayload {
  type: "view_closed";
  view: {
    id: string;
    callback_id?: string;
    hash: string;
    private_metadata?: string;
  };
}

interface ShortcutPayload extends BaseSlackInteractionPayload {
  type: "shortcut";
  callback_id: string;
}

interface MessageActionPayload extends BaseSlackInteractionPayload {
  type: "message_action";
  callback_id: string;
  message: {
    ts: string;
    thread_ts?: string;
    text?: string;
    user?: string;
  };
}

export type SlackInteractionPayload =
  | BlockActionsPayload
  | ViewSubmissionPayload
  | ViewClosedPayload
  | ShortcutPayload
  | MessageActionPayload;

// Zod schema for runtime validation of Slack interaction payloads
// Slack Modal Definition Types
interface SlackPlainTextElement {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackModalDefinition {
  type: "modal";
  title: SlackPlainTextElement;
  callback_id?: string;
  submit?: SlackPlainTextElement;
  close?: SlackPlainTextElement;
  blocks: any[]; // Block Kit blocks
  private_metadata?: string;
}

export type SlackModalDefinitions = Record<string, SlackModalDefinition>;

// Zod schemas for modal definitions
export const SlackPlainTextElement = z.object({
  type: z.literal("plain_text").optional().default("plain_text"),
  text: z.string(),
});

export const SlackModalDefinition = z.object({
  type: z.literal("modal").optional().default("modal"),
  title: SlackPlainTextElement,
  callback_id: z.string().optional(),
  submit: SlackPlainTextElement.optional(),
  close: SlackPlainTextElement.optional(),
  blocks: z.array(z.any()),
  private_metadata: z.string().optional(),
});

export const slackModalDefinitionsSchema = z
  .record(z.string(), SlackModalDefinition)
  .optional()
  .describe(
    "Modal definitions keyed by button action_id. When a button with matching action_id is clicked, the corresponding modal will open.",
  );

export const SlackInteractionPayload = z.union([
  z.object({
    type: z.literal("block_actions"),
    user: z.object({
      id: z.string(),
      username: z.string().optional(),
      name: z.string().optional(),
      team_id: z.string().optional(),
    }),
    team: z
      .object({
        id: z.string(),
        domain: z.string().optional(),
      })
      .optional(),
    channel: z
      .object({
        id: z.string(),
        name: z.string().optional(),
      })
      .optional(),
    trigger_id: z.string().optional(),
    response_url: z.string().optional(),
    token: z.string().optional(),
    actions: z.array(
      z.object({
        action_id: z.string(),
        type: z.string(),
        value: z.string().optional(),
        text: z
          .object({
            type: z.string(),
            text: z.string(),
          })
          .optional(),
        selected_option: z
          .object({
            text: z.object({
              type: z.string(),
              text: z.string(),
            }),
            value: z.string(),
          })
          .optional(),
      }),
    ),
    message: z
      .object({
        ts: z.string(),
        thread_ts: z.string().optional(),
        text: z.string().optional(),
        user: z.string().optional(),
      })
      .optional(),
    container: z
      .object({
        channel_id: z.string().optional(),
        thread_ts: z.string().optional(),
        message_ts: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("view_submission"),
    user: z.object({
      id: z.string(),
      username: z.string().optional(),
      name: z.string().optional(),
      team_id: z.string().optional(),
    }),
    team: z
      .object({
        id: z.string(),
        domain: z.string().optional(),
      })
      .optional(),
    channel: z
      .object({
        id: z.string(),
        name: z.string().optional(),
      })
      .optional(),
    trigger_id: z.string().optional(),
    response_url: z.string().optional(),
    token: z.string().optional(),
    view: z.object({
      id: z.string(),
      callback_id: z.string().optional(),
      hash: z.string(),
      title: z
        .object({
          type: z.string(),
          text: z.string(),
        })
        .optional(),
      state: z
        .object({
          values: z.record(z.string(), z.record(z.string(), z.any())),
        })
        .optional(),
      private_metadata: z.string().optional(),
    }),
  }),
  // For other interaction types, use a more lenient schema
  z.object({
    type: z.enum(["view_closed", "shortcut", "message_action"]),
    user: z.object({
      id: z.string(),
      username: z.string().optional(),
      name: z.string().optional(),
      team_id: z.string().optional(),
    }),
    team: z
      .object({
        id: z.string(),
        domain: z.string().optional(),
      })
      .optional(),
    channel: z
      .object({
        id: z.string(),
        name: z.string().optional(),
      })
      .optional(),
    trigger_id: z.string().optional(),
    response_url: z.string().optional(),
    token: z.string().optional(),
    callback_id: z.string().optional(),
    view: z.any().optional(),
    message: z.any().optional(),
  }),
]);

export interface SlackWebhookPayload {
  token?: string;
  team_id?: string;
  event?: SlackEvent;
  authorizations?: Array<{
    enterprise_id?: string;
    team_id?: string;
    user_id?: string;
    is_bot: boolean;
  }>;
}
