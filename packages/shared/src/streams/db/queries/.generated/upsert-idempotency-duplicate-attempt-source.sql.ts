import type { SyncClient } from "sqlfu";

const sql = `
insert into idempotency_duplicate_attempt_sources (
  idempotency_key,
  source_label,
  duplicate_attempts,
  first_duplicate_at_ms,
  last_duplicate_at_ms
)
values (
  ?,
  ?,
  1,
  ?,
  ?
)
on conflict (idempotency_key, source_label) do update set
  duplicate_attempts = idempotency_duplicate_attempt_sources.duplicate_attempts + 1,
  last_duplicate_at_ms = excluded.last_duplicate_at_ms;
`.trim();
const query = (params: upsertIdempotencyDuplicateAttemptSource.Params) => ({
  name: "upsertIdempotencyDuplicateAttemptSource",
  sql,
  args: [
    params.idempotencyKey,
    params.sourceLabel,
    params.firstDuplicateAtMs,
    params.lastDuplicateAtMs,
  ],
});

export const upsertIdempotencyDuplicateAttemptSource = Object.assign(
  function upsertIdempotencyDuplicateAttemptSource(
    client: SyncClient,
    params: upsertIdempotencyDuplicateAttemptSource.Params,
  ) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace upsertIdempotencyDuplicateAttemptSource {
  export type Params = {
    idempotencyKey: string;
    sourceLabel: string;
    firstDuplicateAtMs: number;
    lastDuplicateAtMs: number;
  };
}
