import { defineConfig } from "sqlfu";

export default defineConfig({
  db: "./.sqlfu/dev.sqlite",
  migrations: "./src/db/migrations",
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
