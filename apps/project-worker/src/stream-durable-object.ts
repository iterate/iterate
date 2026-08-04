// StreamDurableObject — a minimal append-only event log (target-core §5). One DO per (projectId, streamPath),
// addressed by name `${projectId}:${streamPath}`, so a project can only ever name its own streams. Deliberately
// thin: append + monotonic offset + replay. The delivery spine (processors/folds, checkpoints, obligations)
// and the canonical `iterate/processors` event shape are deferred (target-core §5).

import { DurableObject } from "cloudflare:workers";

export type StreamEventInput = { type: string; payload?: unknown };
export type StreamEvent = { offset: number; type: string; createdAt: string; payload: unknown };

export class StreamDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // `offset` AUTOINCREMENT so sqlite_sequence survives row eviction — a deleted tail never reissues an
    // offset a reader already saw (the apps/os highestAssignedOffset semantics).
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
         type TEXT NOT NULL,
         created_at TEXT NOT NULL,
         payload TEXT
       )`,
    );
  }

  /** Append one event; returns its committed offset. */
  append(input: StreamEventInput): { offset: number } {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, created_at, payload) VALUES (?, ?, ?)",
      input.type,
      new Date(Date.now()).toISOString(),
      JSON.stringify(input.payload ?? null),
    );
    return { offset: Number(this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS o").one().o) };
  }

  /** Replay events with offset > afterOffset (the poll-based read; push delivery is deferred). */
  read(afterOffset = 0, limit = 1000): StreamEvent[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT offset, type, created_at, payload FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => ({
        offset: Number(r.offset),
        type: String(r.type),
        createdAt: String(r.created_at),
        payload: r.payload === null ? null : JSON.parse(String(r.payload)),
      }));
  }
}
