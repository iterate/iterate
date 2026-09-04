// reduce-checkpoint.ts — THE ONE spelling of a persisted reduce checkpoint, shared by BOTH hosts:
// the stream's own core reduce (stream.ts — written inside every commit's transaction) and the
// facet-hosted `ProcessorEngine` (processor.ts — driven away from the commit point). ONE ROW per
// slug in `reduce_checkpoints`: the reducer version, the offset reduced through, and the state as
// JSON (NULL = the reduce never changed it = `initialState()` — a pure side-effect processor
// reusing its cursor never re-fires its effect history). ONE statement per write, so a checkpoint
// can never tear (a cursor landing while its state did not); the state column is rewritten only
// when the reduce changed it (`COALESCE`), so an unchanged batch never rewrites the blob.
//
// THE CELL CEILING: a checkpoint is one SQLite cell — 2 MB in production, SQLITE_TOOBIG past it. A
// state whose JSON would not fit is refused BEFORE the write with a coded error, so the caller sees
// why instead of the platform's raw message, and nothing lands. No cloudflare:workers import on
// purpose: this module rides the SDK bundle into every facet isolate.

import { codedError } from "../lib/errors.ts";

/** The most chars a checkpoint's JSON state may be — under the documented 2 MB cell, with room for
 *  the row's other columns. */
export const REDUCE_CHECKPOINT_STATE_MAX_CHARS = 2 * 1024 * 1024 - 4096;

/** Sync SQLite as the platform hands it over (`ctx.storage.sql`): a query is a LAZY cursor —
 *  iterate it, or `toArray()`. Spelled structurally so a node:sqlite stand-in satisfies it. */
export type SqlStorageHandle = {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): Iterable<T> & { toArray(): T[] };
};

/** A persisted checkpoint as read back: the version it was reduced under (the caller gates on it),
 *  the offset reduced through, and the state — `undefined` when the reduce never changed it. */
export type ReduceCheckpoint<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State | undefined;
};

/** What a host reads and writes its checkpoints through — the table below, or the unit lane's
 *  in-memory stand-in (stream/test-support.ts). */
export interface ReduceCheckpointStore {
  read<State>(slug: string): ReduceCheckpoint<State> | undefined;
  /** ALWAYS the cursor; the state ONLY when `stateChanged` — one write either way. */
  write<State>(
    slug: string,
    cursor: { reducerVersion: string; reducedThroughOffset: number },
    state: State,
    stateChanged: boolean,
  ): void;
}

export class ReduceCheckpointTable implements ReduceCheckpointStore {
  readonly #sql: SqlStorageHandle;

  /** `createTable: false` when the caller knows the table exists (the stream's storage skips every
   *  CREATE on a re-wake); a facet host constructs one per incarnation and lets it create. */
  constructor(sql: SqlStorageHandle, options: { createTable: boolean } = { createTable: true }) {
    this.#sql = sql;
    if (options.createTable) ReduceCheckpointTable.createTable(sql);
  }

  static createTable(sql: SqlStorageHandle): void {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS reduce_checkpoints (
         slug TEXT PRIMARY KEY,
         reducer_version TEXT NOT NULL,
         reduced_through_offset INTEGER NOT NULL,
         state TEXT
       )`,
    );
  }

  read<State>(slug: string): ReduceCheckpoint<State> | undefined {
    const row = this.#sql
      .exec<{ reducer_version: string; reduced_through_offset: number; state: string | null }>(
        "SELECT reducer_version, reduced_through_offset, state FROM reduce_checkpoints WHERE slug = ?",
        slug,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      reducerVersion: String(row.reducer_version),
      reducedThroughOffset: Number(row.reduced_through_offset),
      state: row.state === null ? undefined : (JSON.parse(String(row.state)) as State),
    };
  }

  write<State>(
    slug: string,
    cursor: { reducerVersion: string; reducedThroughOffset: number },
    state: State,
    stateChanged: boolean,
  ): void {
    const serializedState = stateChanged ? (JSON.stringify(state) ?? null) : null;
    if (serializedState !== null && serializedState.length > REDUCE_CHECKPOINT_STATE_MAX_CHARS)
      throw codedError(
        "REDUCE_CHECKPOINT_TOO_LARGE",
        `checkpoint "${slug}": the reduced state serializes to ${serializedState.length} chars, over the ${REDUCE_CHECKPOINT_STATE_MAX_CHARS}-char ceiling of one storage cell (2 MB) — a reduce must keep a summary, not the events; nothing was written`,
        { slug, chars: serializedState.length, maxChars: REDUCE_CHECKPOINT_STATE_MAX_CHARS },
      );
    this.#sql.exec(
      `INSERT INTO reduce_checkpoints (slug, reducer_version, reduced_through_offset, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           reducer_version = excluded.reducer_version,
           reduced_through_offset = excluded.reduced_through_offset,
           state = COALESCE(excluded.state, reduce_checkpoints.state)`,
      slug,
      cursor.reducerVersion,
      cursor.reducedThroughOffset,
      serializedState,
    );
  }
}
