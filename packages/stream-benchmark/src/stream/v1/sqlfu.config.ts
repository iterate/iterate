import { defineConfig } from "sqlfu";

// sqlfu project for the per-DO-instance SQLite database used by Stream v1.
// There is no central database to point `db` at — every Durable Object instance
// owns its own SQLite, and migrations are applied from the bundled migrate(client)
// export inside the DO constructor. Useful commands here are `generate`, `draft`,
// and `check migrations-match-definitions`.
export default defineConfig({
  migrations: "./db/migrations",
  definitions: "./db/definitions.sql",
  queries: "./db/queries",
  generate: { sync: true },
});
