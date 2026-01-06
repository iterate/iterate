import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { AgentEvent, AgentEventInput, SlackWebhookPayload } from "./schemas/events.ts";

const agentNameParam = HttpApiSchema.param("agentName", Schema.String);
const sessionIdParam = HttpApiSchema.param("sessionId", Schema.String);
const secretKeyParam = HttpApiSchema.param("key", Schema.String);

export class SqlError extends Schema.TaggedError<SqlError>()("SqlError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {}

const AgentsGroup = HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.put("createAgent")`/agents/${agentNameParam}`
      .addSuccess(Schema.Struct({ created: Schema.Boolean }))
      .addError(SqlError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("addEvent")`/agents/${agentNameParam}`
      .setPayload(Schema.Union(AgentEventInput, Schema.Array(AgentEventInput)))
      .addSuccess(Schema.Struct({ count: Schema.Number }))
      .addError(SqlError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("getEvents")`/agents/${agentNameParam}`
      .setUrlParams(
        Schema.Struct({
          from_offset: Schema.optional(Schema.NumberFromString),
          to_offset: Schema.optional(Schema.NumberFromString),
        }),
      )
      .addSuccess(Schema.Array(AgentEvent))
      .addError(SqlError, { status: 500 }),
  );

const SlackGroup = HttpApiGroup.make("slack").add(
  HttpApiEndpoint.post("receiveWebhook", "/slack-receiver")
    .setPayload(SlackWebhookPayload)
    .addSuccess(Schema.Struct({ ok: Schema.Boolean }))
    .addError(SqlError, { status: 500 }),
);

const InternalGroup = HttpApiGroup.make("internal")
  .add(
    HttpApiEndpoint.get("getSessionMapping")`/internal/session-mapping/${sessionIdParam}`
      .addSuccess(Schema.Struct({ agentId: Schema.String }))
      .addError(NotFoundError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get("getSecret")`/internal/secrets/${secretKeyParam}`
      .addSuccess(Schema.Struct({ value: Schema.String }))
      .addError(NotFoundError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get("listAgents", "/internal/agents").addSuccess(
      Schema.Array(Schema.Struct({ name: Schema.String, createdAt: Schema.String })),
    ),
  );

export class TwoApi extends HttpApi.make("two")
  .add(AgentsGroup)
  .add(SlackGroup)
  .add(InternalGroup) {}
