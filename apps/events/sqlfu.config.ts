import { defineConfig } from "sqlfu";

export default defineConfig({
  migrations: { path: "./src/db/migrations", prefix: "four-digit" },
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
