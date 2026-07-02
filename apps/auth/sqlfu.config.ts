import fs from "node:fs";
import path from "node:path";
import { Miniflare } from "miniflare";
import { createD1Client, defineConfig, type DisposableAsyncClient } from "sqlfu";

const here = import.meta.dirname;
const wranglerPath = path.join(here, ".alchemy", "local", "wrangler.jsonc");
const persistRoot = path.join(here, "..", "..", ".alchemy", "miniflare", "v3");

async function openAlchemyLocalD1(): Promise<DisposableAsyncClient> {
  if (!fs.existsSync(wranglerPath)) {
    throw new Error(
      `sqlfu.config.ts: ${wranglerPath} not found. Run \`pnpm dev\` once to materialize alchemy's local wrangler config, then retry.`,
    );
  }

  const wrangler = JSON.parse(fs.readFileSync(wranglerPath, "utf8"));
  const d1 = (wrangler.d1_databases ?? []).find(
    (binding: { binding: string }) => binding.binding === "DB",
  );
  if (!d1) {
    throw new Error(`sqlfu.config.ts: no d1_databases binding "DB" in ${wranglerPath}.`);
  }

  const mf = new Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: persistRoot,
    d1Persist: true,
    d1Databases: { DB: d1.database_id },
  });
  await mf.ready;

  const database = await mf.getD1Database("DB");
  return {
    client: createD1Client(database),
    async [Symbol.asyncDispose]() {
      await mf.dispose();
    },
  };
}

export default defineConfig({
  db: openAlchemyLocalD1,
  migrations: {
    path: "./src/server/db/migrations",
    preset: "d1",
  },
  definitions: "./src/server/db/definitions.sql",
  queries: "./src/server/db/queries",
});
