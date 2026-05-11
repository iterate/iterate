import { defineConfig } from "sqlfu";
import { findMiniflareD1Path } from "sqlfu/cloudflare";

const devStage = process.env.ALCHEMY_STAGE || "dev";
const devD1Name = `semaphore-${devStage}-resources`;

export default defineConfig({
  db: findMiniflareD1Path(devD1Name, { cwd: import.meta.dirname }),
  migrations: { path: "./src/db/migrations", preset: "d1" },
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
