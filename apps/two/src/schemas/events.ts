import { Schema } from "effect";

export class AgentEvent extends Schema.Class<AgentEvent>("AgentEvent")({
  id: Schema.String,
  agentName: Schema.String,
  type: Schema.String,
  payload: Schema.Unknown,
  timestamp: Schema.DateTimeUtc,
  offset: Schema.Number,
}) {}

export class AgentEventInput extends Schema.Class<AgentEventInput>("AgentEventInput")({
  type: Schema.String,
  payload: Schema.Unknown,
}) {}

export const GetEventsQuery = Schema.Struct({
  from_offset: Schema.optional(Schema.NumberFromString),
  to_offset: Schema.optional(Schema.NumberFromString),
  live: Schema.optional(Schema.Literal("true")),
});

export type GetEventsQuery = typeof GetEventsQuery.Type;

export const SlackWebhookPayload = Schema.Struct({
  team_id: Schema.String,
  event: Schema.Struct({
    thread_ts: Schema.optional(Schema.String),
    ts: Schema.String,
    text: Schema.optional(Schema.String),
    user: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
  }),
});

export type SlackWebhookPayload = typeof SlackWebhookPayload.Type;
