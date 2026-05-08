import type { SyncClient } from "sqlfu";

const sql = `
insert into idempotency_duplicate_attempts (
  idempotency_key,
  event_type,
  stream_path,
  target_offset,
  duplicate_attempts,
  first_duplicate_at_ms,
  last_duplicate_at_ms
)
values (
  ?,
  ?,
  ?,
  ?,
  1,
  ?,
  ?
)
on conflict (idempotency_key) do update set
  event_type = excluded.event_type,
  stream_path = excluded.stream_path,
  target_offset = excluded.target_offset,
  duplicate_attempts = idempotency_duplicate_attempts.duplicate_attempts + 1,
  last_duplicate_at_ms = excluded.last_duplicate_at_ms;
`.trim();
const query = (params: upsertIdempotencyDuplicateAttempt.Params) => ({
  name: "upsertIdempotencyDuplicateAttempt",
  sql,
  args: [
    params.idempotencyKey,
    params.eventType,
    params.streamPath,
    params.targetOffset,
    params.firstDuplicateAtMs,
    params.lastDuplicateAtMs,
  ],
});

export const upsertIdempotencyDuplicateAttempt = Object.assign(
  function upsertIdempotencyDuplicateAttempt(
    client: SyncClient,
    params: upsertIdempotencyDuplicateAttempt.Params,
  ) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace upsertIdempotencyDuplicateAttempt {
  export type Params = {
    idempotencyKey: string;
    eventType: string;
    streamPath: string;
    targetOffset: number;
    firstDuplicateAtMs: number;
    lastDuplicateAtMs: number;
  };
}
