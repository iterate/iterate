import { defineConfig } from "sqlfu";

// Build-time only (never bundled): `sqlfu generate` types ./sql against ./definitions.sql — the desired schema is
// the authority, so no database is needed to generate. The remote D1 (`iterate-control-plane-projects`, created
// with `wrangler d1 create`) gets the schema with `pnpm db:schema:remote` — one table, no migration history yet.
export default defineConfig({
  definitions: "./definitions.sql",
  queries: "./sql",
});
