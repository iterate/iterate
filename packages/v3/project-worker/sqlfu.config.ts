import path from "node:path";
import { Miniflare } from "miniflare";
import { createD1Client, defineConfig, type DisposableAsyncClient } from "sqlfu";
import { experimental_readRawConfig } from "wrangler";

// Build/dev-time only (never bundled). sqlfu introspects a local D1 to type ./src/control-plane/sql
// against ./src/control-plane/definitions.sql (the directory schema). The D1 id is wrangler.jsonc's
// (the same local namespace `wrangler dev` persists).
const here = import.meta.dirname;
const persistRoot = path.join(here, ".wrangler", "state", "v3");

async function openLocalDevD1(): Promise<DisposableAsyncClient> {
  const { rawConfig } = experimental_readRawConfig({ config: path.join(here, "wrangler.jsonc") });
  const mf = new Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: persistRoot,
    d1Persist: true,
    d1Databases: { DB: String(rawConfig.d1_databases?.[0]?.database_id) },
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
  db: openLocalDevD1,
  definitions: "./src/control-plane/definitions.sql",
  queries: "./src/control-plane/sql",
});
