import type { SyncClient } from "sqlfu";

const sql = `
select
  coalesce(sum(duplicate_attempts), 0) as duplicate_attempt_count,
  count(*) as duplicate_key_count
from idempotency_duplicate_attempts;
`.trim();
const query = { name: "summarizeIdempotencyDuplicateAttempts", sql, args: [] };

export const summarizeIdempotencyDuplicateAttempts = Object.assign(
  function summarizeIdempotencyDuplicateAttempts(
    client: SyncClient,
  ): summarizeIdempotencyDuplicateAttempts.Result | null {
    const rows = client.all<summarizeIdempotencyDuplicateAttempts.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace summarizeIdempotencyDuplicateAttempts {
  export type Result = {
    duplicate_attempt_count: number;
    duplicate_key_count: number;
  };
}
