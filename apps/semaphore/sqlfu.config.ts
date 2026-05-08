import { defineConfig } from "sqlfu";
import { findMiniflareD1Path } from "sqlfu/cloudflare";

const devStage = process.env.ALCHEMY_STAGE || "dev";
const devD1Name = `semaphore-${devStage}-resources`;

function localD1Path() {
  try {
    return findMiniflareD1Path(devD1Name, { cwd: import.meta.dirname });
  } catch (error) {
    return () => {
      throw new Error(
        `sqlfu.config.ts: no Alchemy Miniflare D1 database found for ${devD1Name}. Run \`pnpm dev\` once to materialize local D1 state, then retry. Cause: ${String(error)}`,
      );
    };
  }
}

export default defineConfig({
  db: localD1Path(),
  migrations: { path: "./src/db/migrations", preset: "d1" },
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
