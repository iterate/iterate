import { HttpApiBuilder } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { Effect, Option } from "effect";
import { NotFoundError, TwoApi } from "../api.ts";
import { SessionManager } from "../opencode/session-manager.ts";

export const InternalHandlersLive = HttpApiBuilder.group(TwoApi, "internal", (handlers) =>
  Effect.gen(function* () {
    const sessionManager = yield* SessionManager;
    const sql = yield* SqlClient.SqlClient;

    return handlers
      .handle("getSessionMapping", ({ path }) =>
        Effect.gen(function* () {
          const agentId = yield* sessionManager
            .getAgentId(path.sessionId)
            .pipe(
              Effect.mapError(
                () => new NotFoundError({ message: `Error looking up session ${path.sessionId}` }),
              ),
            );
          return Option.match(agentId, {
            onNone: () =>
              Effect.fail(
                new NotFoundError({ message: `No agent found for session ${path.sessionId}` }),
              ),
            onSome: (id) => Effect.succeed({ agentId: id }),
          });
        }).pipe(Effect.flatten),
      )
      .handle("getSecret", ({ path }) =>
        Effect.gen(function* () {
          const value = process.env[path.key];
          if (value) {
            return { value };
          }
          return yield* Effect.fail(new NotFoundError({ message: `Secret ${path.key} not found` }));
        }),
      )
      .handle("listAgents", () =>
        Effect.gen(function* () {
          type Row = { name: string; created_at: string };
          const rows = yield* sql<Row>`
            SELECT name, created_at FROM agents ORDER BY created_at DESC
          `.pipe(Effect.orElseSucceed(() => [] as Row[]));
          return rows.map((row) => ({
            name: row.name,
            createdAt: row.created_at,
          }));
        }),
      );
  }),
);
