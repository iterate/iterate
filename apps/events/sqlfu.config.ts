import { defineConfig } from "sqlfu";

export default defineConfig({
  db: "./.sqlfu/dev.sqlite",
  migrations: { path: "./src/db/migrations", prefix: "four-digit" },
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
