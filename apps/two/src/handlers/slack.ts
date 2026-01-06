import { HttpApiBuilder } from "@effect/platform";
import { SqlError as SqlErrorInternal } from "@effect/sql";
import { Effect } from "effect";
import { SqlError, TwoApi } from "../api.ts";
import { EventStore } from "../services/event-store.ts";

const mapSqlError = Effect.mapError(
  (e: SqlErrorInternal.SqlError) => new SqlError({ message: e.message }),
);

export const SlackHandlersLive = HttpApiBuilder.group(TwoApi, "slack", (handlers) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    return handlers.handle("receiveWebhook", ({ payload }) =>
      Effect.gen(function* () {
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        const agentName = `slack:${payload.team_id}:${threadTs}`;

        yield* store.appendEvents(agentName, [
          {
            type: "slack_webhook_raw",
            payload: payload,
          },
        ]);

        const messageText = payload.event.text;
        if (messageText) {
          yield* store.appendEvents(agentName, [
            {
              type: "user_message",
              payload: {
                text: messageText,
                source: "slack",
                user: payload.event.user,
                channel: payload.event.channel,
              },
            },
          ]);
        }

        return { ok: true };
      }).pipe(mapSqlError),
    );
  }),
);
