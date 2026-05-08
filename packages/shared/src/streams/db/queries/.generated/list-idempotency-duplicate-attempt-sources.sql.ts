import type { SyncClient } from "sqlfu";

const sql = `
select
  duplicate_attempts,
  first_duplicate_at_ms,
  idempotency_key,
  last_duplicate_at_ms,
  source_label
from idempotency_duplicate_attempt_sources
order by duplicate_attempts desc, last_duplicate_at_ms desc
limit ?;
`.trim();
const query = (params: listIdempotencyDuplicateAttemptSources.Params) => ({
  name: "listIdempotencyDuplicateAttemptSources",
  sql,
  args: [params.limit],
});

export const listIdempotencyDuplicateAttemptSources = Object.assign(
  function listIdempotencyDuplicateAttemptSources(
    client: SyncClient,
    params: listIdempotencyDuplicateAttemptSources.Params,
  ): listIdempotencyDuplicateAttemptSources.Result[] {
    return client.all<listIdempotencyDuplicateAttemptSources.Result>(query(params));
  },
  { sql, query },
);

export namespace listIdempotencyDuplicateAttemptSources {
  export type Params = {
    limit: number;
  };
  export type Result = {
    duplicate_attempts: number;
    first_duplicate_at_ms: number;
    idempotency_key: string;
    last_duplicate_at_ms: number;
    source_label: string;
  };
}
