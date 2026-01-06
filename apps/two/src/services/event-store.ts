import { SqlClient, SqlError } from "@effect/sql";
import { Context, DateTime, Effect, Layer, Stream } from "effect";
import { AgentEvent, type AgentEventInput } from "../schemas/events.ts";

export class EventStore extends Context.Tag("EventStore")<
  EventStore,
  {
    readonly createAgent: (name: string) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly agentExists: (name: string) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly listAgents: () => Effect.Effect<string[], SqlError.SqlError>;
    readonly appendEvents: (
      agentName: string,
      events: readonly AgentEventInput[],
    ) => Effect.Effect<AgentEvent[], SqlError.SqlError>;
    readonly getEvents: (
      agentName: string,
      fromOffset?: number,
      toOffset?: number,
    ) => Effect.Effect<AgentEvent[], SqlError.SqlError>;
    readonly subscribeEvents: (
      agentName: string,
      fromOffset: number,
    ) => Stream.Stream<AgentEvent, SqlError.SqlError>;
    readonly getLatestOffset: (agentName: string) => Effect.Effect<number, SqlError.SqlError>;
  }
>() {}

export const EventStoreLive = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        "offset" INTEGER NOT NULL,
        FOREIGN KEY (agent_name) REFERENCES agents(name)
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_events_agent_offset 
      ON events(agent_name, "offset")
    `;

    const getNextOffset = (agentName: string) =>
      sql<{ max_offset: number | null }>`
        SELECT MAX("offset") as max_offset FROM events WHERE agent_name = ${agentName}
      `.pipe(Effect.map((rows) => (rows[0]?.max_offset ?? -1) + 1));

    return {
      createAgent: (name) =>
        Effect.gen(function* () {
          const existing = yield* sql`SELECT 1 FROM agents WHERE name = ${name}`;
          if (existing.length > 0) {
            return false;
          }
          yield* sql`INSERT INTO agents (name) VALUES (${name})`;
          return true;
        }),

      agentExists: (name) =>
        sql`SELECT 1 FROM agents WHERE name = ${name}`.pipe(Effect.map((rows) => rows.length > 0)),

      listAgents: () =>
        sql<{ name: string }>`SELECT name FROM agents ORDER BY created_at DESC`.pipe(
          Effect.map((rows) => rows.map((r) => r.name)),
        ),

      appendEvents: (agentName, events) =>
        Effect.gen(function* () {
          const agentExists = yield* sql`SELECT 1 FROM agents WHERE name = ${agentName}`;
          if (agentExists.length === 0) {
            yield* sql`INSERT INTO agents (name) VALUES (${agentName})`;
          }

          let offset = yield* getNextOffset(agentName);
          const now = DateTime.unsafeNow();
          const insertedEvents: AgentEvent[] = [];

          for (const event of events) {
            const id = crypto.randomUUID();
            const timestamp = DateTime.formatIso(now);
            const payloadJson = JSON.stringify(event.payload);

            yield* sql`
              INSERT INTO events (id, agent_name, type, payload, timestamp, "offset")
              VALUES (${id}, ${agentName}, ${event.type}, ${payloadJson}, ${timestamp}, ${offset})
            `;

            insertedEvents.push(
              new AgentEvent({
                id,
                agentName,
                type: event.type,
                payload: event.payload,
                timestamp: now,
                offset,
              }),
            );
            offset++;
          }

          return insertedEvents;
        }),

      getEvents: (agentName, fromOffset, toOffset) =>
        Effect.gen(function* () {
          type Row = {
            id: string;
            agent_name: string;
            type: string;
            payload: string;
            timestamp: string;
            offset: number;
          };

          let rows: readonly Row[];

          if (fromOffset !== undefined && toOffset !== undefined) {
            rows = yield* sql<Row>`
              SELECT * FROM events 
              WHERE agent_name = ${agentName}
              AND "offset" >= ${fromOffset}
              AND "offset" <= ${toOffset}
              ORDER BY "offset" ASC
            `;
          } else if (fromOffset !== undefined) {
            rows = yield* sql<Row>`
              SELECT * FROM events 
              WHERE agent_name = ${agentName}
              AND "offset" >= ${fromOffset}
              ORDER BY "offset" ASC
            `;
          } else if (toOffset !== undefined) {
            rows = yield* sql<Row>`
              SELECT * FROM events 
              WHERE agent_name = ${agentName}
              AND "offset" <= ${toOffset}
              ORDER BY "offset" ASC
            `;
          } else {
            rows = yield* sql<Row>`
              SELECT * FROM events 
              WHERE agent_name = ${agentName}
              ORDER BY "offset" ASC
            `;
          }

          return rows.map(
            (row) =>
              new AgentEvent({
                id: row.id,
                agentName: row.agent_name,
                type: row.type,
                payload: JSON.parse(row.payload),
                timestamp: DateTime.unsafeMake(new Date(row.timestamp)),
                offset: row.offset,
              }),
          );
        }),

      subscribeEvents: (agentName, fromOffset) =>
        Stream.asyncScoped<AgentEvent, SqlError.SqlError>((emit) =>
          Effect.gen(function* () {
            let currentOffset = fromOffset;
            const pollInterval = 500;

            const poll = Effect.gen(function* () {
              type Row = {
                id: string;
                agent_name: string;
                type: string;
                payload: string;
                timestamp: string;
                offset: number;
              };

              const rows = yield* sql<Row>`
                SELECT * FROM events 
                WHERE agent_name = ${agentName}
                AND "offset" >= ${currentOffset}
                ORDER BY "offset" ASC
              `;

              for (const row of rows) {
                const event = new AgentEvent({
                  id: row.id,
                  agentName: row.agent_name,
                  type: row.type,
                  payload: JSON.parse(row.payload),
                  timestamp: DateTime.unsafeMake(new Date(row.timestamp)),
                  offset: row.offset,
                });
                emit.single(event);
                currentOffset = row.offset + 1;
              }
            });

            yield* Effect.forever(poll.pipe(Effect.delay(pollInterval))).pipe(Effect.forkScoped);
          }),
        ),

      getLatestOffset: (agentName) =>
        sql<{ max_offset: number | null }>`
          SELECT MAX("offset") as max_offset FROM events WHERE agent_name = ${agentName}
        `.pipe(Effect.map((rows) => rows[0]?.max_offset ?? -1)),
    };
  }),
);
