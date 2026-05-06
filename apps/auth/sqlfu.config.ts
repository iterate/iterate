import { defineConfig } from "sqlfu";
import { findMiniflareD1Path } from "sqlfu/cloudflare";

export default defineConfig({
  db: findMiniflareD1Path("auth-dev-auth-db"),
  migrations: {
    path: "./src/server/db/migrations",
    preset: "d1",
  },
  definitions: "./src/server/db/definitions.sql",
  queries: "./src/server/db/queries",
});
