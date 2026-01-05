import { HttpApiBuilder } from "@effect/platform";
import { SqlError as SqlErrorInternal } from "@effect/sql";
import { Effect } from "effect";
import { SqlError, TwoApi } from "../api.ts";
import { AgentEventInput } from "../schemas/events.ts";
import { EventStore } from "../services/event-store.ts";

const mapSqlError = Effect.mapError(
  (e: SqlErrorInternal.SqlError) => new SqlError({ message: e.message }),
);

export const AgentsHandlersLive = HttpApiBuilder.group(TwoApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    return handlers
      .handle("createAgent", ({ path }) =>
        store.createAgent(path.agentName).pipe(
          Effect.map((created) => ({ created })),
          mapSqlError,
        ),
      )
      .handle("addEvent", ({ path, payload }) =>
        Effect.gen(function* () {
          const events: AgentEventInput[] = Array.isArray(payload) ? payload : [payload];
          const inserted = yield* store.appendEvents(path.agentName, events);
          return { count: inserted.length };
        }).pipe(mapSqlError),
      )
      .handle("getEvents", ({ path, urlParams }) =>
        store
          .getEvents(path.agentName, urlParams.from_offset, urlParams.to_offset)
          .pipe(mapSqlError),
      );
  }),
);
