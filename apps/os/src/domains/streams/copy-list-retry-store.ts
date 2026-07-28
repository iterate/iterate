import { MAX_DELIVERY_ATTEMPTS } from "./delivery-math.ts";

/**
 * Copying a copy list and sending matching events are both receiver calls.
 * Keep one bounded retry budget so a temporary receiver outage has the same
 * recovery window whichever call happened to encounter it first.
 */
export const MAX_COPY_LIST_ATTEMPTS = MAX_DELIVERY_ATTEMPTS;

/** Durable retry progress for sending one source's current copy list to a receiving stream. */
export type CopyListRetryRow = {
  receivingStreamPath: string;
  sourceOffset: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

/**
 * A source-to-receiver copy crosses two Durable Objects and cannot share the
 * source event's transaction. This table stores only retry progress. The
 * subscriptions and latest source offset remain in the source's reduced state.
 *
 * The primary key is the receiver path. A newer source change replaces the
 * pending offset and clears its old failure count, so bursts collapse to one
 * latest-wins list instead of accumulating a chain of changes.
 */
export class CopyListRetryStore {
  readonly #sql: SqlStorage;
  readonly #onMutation: () => void;

  constructor(sqlStorage: SqlStorage, options: { onMutation?: () => void } = {}) {
    this.#sql = sqlStorage;
    this.#onMutation = options.onMutation ?? (() => undefined);
    this.#sql.exec(`create table if not exists copy_list_retries (
      receiving_stream_path text primary key,
      source_offset integer not null,
      attempt integer not null default 0,
      next_attempt_at integer,
      last_error text,
      updated_at text not null
    )`);
  }

  get(receivingStreamPath: string): CopyListRetryRow | undefined {
    const record = this.#sql
      .exec<CopyListRetryRecord>(
        `select receiving_stream_path, source_offset, attempt,
                next_attempt_at, last_error
         from copy_list_retries
         where receiving_stream_path = ? limit 1`,
        receivingStreamPath,
      )
      .toArray()[0];
    return record === undefined ? undefined : rowFromRecord(record);
  }

  list(): CopyListRetryRow[] {
    return this.#sql
      .exec<CopyListRetryRecord>(
        `select receiving_stream_path, source_offset, attempt,
                next_attempt_at, last_error
         from copy_list_retries`,
      )
      .toArray()
      .map(rowFromRecord);
  }

  ensure(receivingStreamPath: string, sourceOffset: number): CopyListRetryRow {
    const current = this.get(receivingStreamPath);
    if (current !== undefined && current.sourceOffset >= sourceOffset) return current;
    this.#sql.exec(
      `insert into copy_list_retries (
         receiving_stream_path, source_offset, updated_at
       ) values (?, ?, ?)
       on conflict (receiving_stream_path) do update set
         source_offset = excluded.source_offset,
         attempt = 0,
         next_attempt_at = null,
         last_error = null,
         updated_at = excluded.updated_at
       where copy_list_retries.source_offset < excluded.source_offset`,
      receivingStreamPath,
      sourceOffset,
      new Date().toISOString(),
    );
    this.#onMutation();
    return this.get(receivingStreamPath)!;
  }

  fail(
    receivingStreamPath: string,
    args: { sourceOffset: number; attempt: number; nextAttemptAt: number; error: string },
  ): void {
    this.#sql.exec(
      `update copy_list_retries
       set attempt = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       where receiving_stream_path = ? and source_offset = ?`,
      args.attempt,
      args.nextAttemptAt,
      args.error.slice(0, 2_000),
      new Date().toISOString(),
      receivingStreamPath,
      args.sourceOffset,
    );
    this.#onMutation();
  }

  delete(receivingStreamPath: string, sourceOffset?: number): void {
    if (sourceOffset === undefined) {
      this.#sql.exec(
        "delete from copy_list_retries where receiving_stream_path = ?",
        receivingStreamPath,
      );
    } else {
      this.#sql.exec(
        "delete from copy_list_retries where receiving_stream_path = ? and source_offset = ?",
        receivingStreamPath,
        sourceOffset,
      );
    }
    this.#onMutation();
  }

  prune(desiredReceiverPaths: ReadonlySet<string>): void {
    for (const row of this.list()) {
      if (!desiredReceiverPaths.has(row.receivingStreamPath)) this.delete(row.receivingStreamPath);
    }
  }
}

type CopyListRetryRecord = {
  receiving_stream_path: string;
  source_offset: number;
  attempt: number;
  next_attempt_at: number | null;
  last_error: string | null;
};

function rowFromRecord(record: CopyListRetryRecord): CopyListRetryRow {
  return {
    receivingStreamPath: record.receiving_stream_path,
    sourceOffset: record.source_offset,
    attempt: record.attempt,
    nextAttemptAt: record.next_attempt_at,
    lastError: record.last_error,
  };
}
