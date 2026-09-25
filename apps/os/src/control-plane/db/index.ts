// src/control-plane/db/index.ts — THE CONTROL PLANE'S D1 (binding DB). The schema is
// definitions.sql, and every query a named statement in queries/*.sql that sqlfu types into
// queries/.generated/<file>.sql.ts (apps/os/README.md). One statement runs through sqlfu's D1
// client: `projectsByRef(createD1Client(env.DB), { id, slug })`.
//
// Statements that must stand whole run through `batch`: one D1 transaction, the statements in
// order, each seeing the ones before, and a failure rolls every one back
// (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). A database runs one query
// at a time (https://developers.cloudflare.com/d1/platform/limits/), so a guard written into a
// statement (`where not exists …`, `on conflict`) holds against every other isolate, where a read
// in JS followed by a write does not. sqlfu's `transaction()` is no transaction on D1: its adapter
// only calls the callback (mmkal/sqlfu packages/sqlfu/src/adapters/d1.ts).
//
// A batch answers D1's own rows, keyed by the SQL's column aliases, so every SELECT aliases its
// columns as its generated `Result`'s keys (`org_id as orgId`): a batch row is that `Result`.
import type { SqlQuery } from "sqlfu";

export const batch = (d1: D1Database, queries: SqlQuery[]) =>
  d1.batch(queries.map((query) => d1.prepare(query.sql).bind(...query.args)));
