import fs from "node:fs";
import path from "node:path";
import { defineConfig, createD1Client, type DisposableAsyncClient } from "sqlfu";
import { Miniflare } from "miniflare";

// Opens alchemy's local miniflare D1 so `sqlfu migrate`, `sqlfu check`, the UI,
// etc. operate on the same database `pnpm dev` does. Requires `pnpm dev` (or
// `pnpm alchemy:up`) to have run at least once to materialize the persist dir
// and the wrangler.jsonc with binding metadata.
//
// `sqlfu generate` uses authority: 'desired_schema' (the default) and does NOT
// call this factory — typegen reads definitions.sql directly.
const here = import.meta.dirname;
const wranglerPath = path.join(here, ".alchemy", "local", "wrangler.jsonc");
const persistRoot = path.join(here, "..", "..", ".alchemy", "miniflare", "v3");

async function openAlchemyLocalD1(): Promise<DisposableAsyncClient> {
  if (!fs.existsSync(wranglerPath)) {
    throw new Error(
      `sqlfu.config.ts: ${wranglerPath} not found. Run \`pnpm alchemy:up\` or \`pnpm dev\` once to materialize alchemy's local wrangler config, then retry.`,
    );
  }
  const wrangler = JSON.parse(fs.readFileSync(wranglerPath, "utf8"));
  const d1 = (wrangler.d1_databases ?? []).find((b: { binding: string }) => b.binding === "DB");
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
  migrations: { path: "./src/db/migrations", prefix: "four-digit" },
  definitions: "./src/db/definitions.sql",
  queries: "./src/db/queries",
});
