import path from "node:path";
import { Miniflare } from "miniflare";
import { createD1Client, defineConfig, type DisposableAsyncClient } from "sqlfu";

// Build/dev-time only (never bundled). sqlfu introspects a local D1 to type ./src/control-plane/sql
// against ./src/control-plane/definitions.sql (the directory schema) and manages its migrations.
const here = import.meta.dirname;
const persistRoot = path.join(here, ".wrangler", "state", "v3");
const DB_ID = "fb3502bf-da4c-42e7-8e70-6f75765f7a4d"; // control-plane-directory (POC account)

async function openLocalDevD1(): Promise<DisposableAsyncClient> {
  const mf = new Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: persistRoot,
    d1Persist: true,
    d1Databases: { DB: DB_ID },
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
  migrations: { path: "./src/control-plane/migrations", preset: "d1" },
  definitions: "./src/control-plane/definitions.sql",
  queries: "./src/control-plane/sql",
});
