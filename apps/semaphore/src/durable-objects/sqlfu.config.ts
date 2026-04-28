import { defineConfig } from "sqlfu";

export default defineConfig({
  migrations: "./db/migrations",
  definitions: "./db/definitions.sql",
  queries: "./db/queries",
  generate: { sync: true },
});
