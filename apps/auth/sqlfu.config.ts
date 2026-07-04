import path from "node:path";
import { Miniflare } from "miniflare";
import { createD1Client, defineConfig, type DisposableAsyncClient } from "sqlfu";
import { LOCAL_DEV_AUTH_DB_ID } from "./scripts/generate-wrangler-config.ts";

const here = import.meta.dirname;

// Local dev D1 lives where the @cloudflare/vite-plugin persists it
// (`.wrangler/state/v3` under the app root), keyed by the stable placeholder
// database id from the generated wrangler.jsonc — so sqlfu operates on the
// exact database `pnpm dev` serves.
const persistRoot = path.join(here, ".wrangler", "state", "v3");

async function openLocalDevD1(): Promise<DisposableAsyncClient> {
  const mf = new Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: persistRoot,
    d1Persist: true,
    d1Databases: { DB: LOCAL_DEV_AUTH_DB_ID },
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
  migrations: {
    path: "./src/server/db/migrations",
    preset: "d1",
  },
  definitions: "./src/server/db/definitions.sql",
  queries: "./src/server/db/queries",
});
