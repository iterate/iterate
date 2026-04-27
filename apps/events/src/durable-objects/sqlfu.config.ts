import { defineConfig } from "sqlfu";

// sqlfu project for the per-DO-instance SQLite database used by
// StreamDurableObject. There is no central database to point `db` at — every
// Durable Object instance owns its own SQLite, and migrations are applied
// from the bundled `migrate(client)` export inside the DO constructor (see
// `stream.ts`). Commands that need a live DB connection (`migrate`, `sync`,
// the UI's SQL runner) will throw; the useful commands here are `generate`,
// `draft`, and `check.migrationsMatchDefinitions`.
export default defineConfig({
  migrations: "./db/migrations",
  definitions: "./db/definitions.sql",
  queries: "./db/queries",
  generate: { sync: true },
});
