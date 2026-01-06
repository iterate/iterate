import { SqlClient, SqlError } from "@effect/sql";
import { Context, Effect, Layer, Option } from "effect";

export interface SessionMapping {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  createdAt: string;
}

export class SessionManager extends Context.Tag("SessionManager")<
  SessionManager,
  {
    readonly getSessionId: (
      agentId: string,
    ) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
    readonly getAgentId: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
    readonly createMapping: (
      agentId: string,
      sessionId: string,
      workingDirectory: string,
    ) => Effect.Effect<SessionMapping, SqlError.SqlError>;
    readonly deleteMapping: (agentId: string) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly getAllMappings: () => Effect.Effect<SessionMapping[], SqlError.SqlError>;
  }
>() {}

export const SessionManagerLive = Layer.effect(
  SessionManager,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS session_mappings (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        working_directory TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_session_mappings_session_id 
      ON session_mappings(session_id)
    `;

    return {
      getSessionId: (agentId) =>
        Effect.gen(function* () {
          type Row = { session_id: string };
          const rows = yield* sql<Row>`
            SELECT session_id FROM session_mappings WHERE agent_id = ${agentId}
          `;
          return rows.length > 0 ? Option.some(rows[0].session_id) : Option.none();
        }),

      getAgentId: (sessionId) =>
        Effect.gen(function* () {
          type Row = { agent_id: string };
          const rows = yield* sql<Row>`
            SELECT agent_id FROM session_mappings WHERE session_id = ${sessionId}
          `;
          return rows.length > 0 ? Option.some(rows[0].agent_id) : Option.none();
        }),

      createMapping: (agentId, sessionId, workingDirectory) =>
        Effect.gen(function* () {
          const now = new Date().toISOString();
          yield* sql`
            INSERT INTO session_mappings (agent_id, session_id, working_directory, created_at)
            VALUES (${agentId}, ${sessionId}, ${workingDirectory}, ${now})
            ON CONFLICT (agent_id) DO UPDATE SET
              session_id = ${sessionId},
              working_directory = ${workingDirectory}
          `;
          return {
            agentId,
            sessionId,
            workingDirectory,
            createdAt: now,
          };
        }),

      deleteMapping: (agentId) =>
        Effect.gen(function* () {
          const existing = yield* sql`SELECT 1 FROM session_mappings WHERE agent_id = ${agentId}`;
          if (existing.length === 0) {
            return false;
          }
          yield* sql`DELETE FROM session_mappings WHERE agent_id = ${agentId}`;
          return true;
        }),

      getAllMappings: () =>
        Effect.gen(function* () {
          type Row = {
            agent_id: string;
            session_id: string;
            working_directory: string;
            created_at: string;
          };
          const rows = yield* sql<Row>`
            SELECT agent_id, session_id, working_directory, created_at 
            FROM session_mappings 
            ORDER BY created_at DESC
          `;
          return rows.map((row) => ({
            agentId: row.agent_id,
            sessionId: row.session_id,
            workingDirectory: row.working_directory,
            createdAt: row.created_at,
          }));
        }),
    };
  }),
);
