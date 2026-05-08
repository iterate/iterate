import type { SyncClient } from "sqlfu";

const sql = `
select
  duplicate_attempts,
  event_type,
  first_duplicate_at_ms,
  idempotency_key,
  last_duplicate_at_ms,
  stream_path,
  target_offset
from idempotency_duplicate_attempts
order by duplicate_attempts desc, last_duplicate_at_ms desc
limit ?;
`.trim();
const query = (params: listIdempotencyDuplicateAttempts.Params) => ({
  name: "listIdempotencyDuplicateAttempts",
  sql,
  args: [params.limit],
});

export const listIdempotencyDuplicateAttempts = Object.assign(
  function listIdempotencyDuplicateAttempts(
    client: SyncClient,
    params: listIdempotencyDuplicateAttempts.Params,
  ): listIdempotencyDuplicateAttempts.Result[] {
    return client.all<listIdempotencyDuplicateAttempts.Result>(query(params));
  },
  { sql, query },
);

export namespace listIdempotencyDuplicateAttempts {
  export type Params = {
    limit: number;
  };
  export type Result = {
    duplicate_attempts: number;
    event_type: string;
    first_duplicate_at_ms: number;
    idempotency_key: string;
    last_duplicate_at_ms: number;
    stream_path: string;
    target_offset: number;
  };
}
