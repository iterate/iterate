import { DurableObject } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "iterate/processors";

// ---------------------------------------------------------------------------
// The STREAM Durable Object — the durable log. One DO instance per (projectId, path); addressed by name
// `<projectId>::<path>` from the unforgeable projectId prop, so a project can never reach another's streams.
//
// D-B (2026-07-31): adopts apps/os's CANONICAL append contract — the real `StreamEventInput`/`StreamEvent`
// types from `iterate/processors` (type-only import — no runtime dep, kernel stays pure-play). So the
// kernel's stream *interface* is the real one from day one, converting the future migration from a rewrite
// into a drop-in. What we adopt now: **offset** (monotonic, survives eviction via sqlite_sequence),
// **idempotencyKey** (unique — a re-append returns the already-committed event), **ephemeral**, and the
// committed shape (`offset`, `createdAt`, `path`).
//
// DELIBERATELY STUBBED (the delivery spine — apps/os's `stream-subscribers.ts` +
// `SqliteSubscriptionCursorStore` + the reduce/fold processor step): subscription cursors, park/resume,
// obligations, and optimistic offset-conflict CAS (`StreamOffsetConflictError`). `read(afterOffset)` is a
// poll-based replay, enough to prove the topology. The storage engine itself (apps/os `stream-storage.ts`,
// `StreamEventLog`) is NOT importable — it lives in apps/os, welded to that package; only the CONTRACT
// (this file's imported types) is shared. See wayfinder/reuse-feasibility.md + morning-brief D-B.
// ---------------------------------------------------------------------------

export type { StreamEvent, StreamEventInput };

export class StreamDurableObject extends DurableObject {
  readonly #path: string;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // The DO name is `<projectId>::<path>`; recover the path (everything after the first "::").
    const name = ctx.id.name ?? "";
    const sep = name.indexOf("::");
    this.#path = sep === -1 ? "" : name.slice(sep + 2);
    this.ctx.storage.sql.exec(
      // `offset` is the replay cursor (AUTOINCREMENT so sqlite_sequence survives row eviction — a deleted
      // tail never reissues an offset a subscriber already saw). `idempotency_key` UNIQUE is the dedup index.
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
         type TEXT NOT NULL,
         created_at TEXT NOT NULL,
         idempotency_key TEXT UNIQUE,
         ephemeral INTEGER NOT NULL DEFAULT 0,
         payload TEXT,
         metadata TEXT,
         source TEXT
       )`,
    );
  }

  // Append one event (the canonical `StreamEventInput`); returns the committed `StreamEvent`. Idempotent:
  // re-appending the same `idempotencyKey` returns the already-committed event (no second row, no new offset).
  append(input: StreamEventInput): StreamEvent {
    const idem = input.idempotencyKey ?? null;
    if (idem !== null) {
      const existing = this.#byIdempotencyKey(idem);
      if (existing) return existing;
    }
    const createdAt = new Date(this.#now()).toISOString(); // canonical contract: createdAt is an ISO string
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, created_at, idempotency_key, ephemeral, payload, metadata, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      input.type,
      createdAt,
      idem,
      input.ephemeral ? 1 : 0,
      JSON.stringify(input.payload ?? null),
      JSON.stringify(input.metadata ?? null),
      JSON.stringify(input.source ?? null),
    );
    const offset = Number(this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS o").one().o);
    return this.#row(offset)!;
  }

  // Replay events with offset > afterOffset (the poll-based subscribe primitive; the real push-delivery
  // spine is stubbed — see header).
  read(afterOffset = 0, limit = 1000): StreamEvent[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT offset, type, created_at, idempotency_key, ephemeral, payload, metadata, source FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => this.#hydrate(r));
  }

  // The highest offset ever ASSIGNED, even if its row was since evicted (reads AUTOINCREMENT's
  // sqlite_sequence — the apps/os `highestAssignedOffset` semantics, so a tail eviction never reissues).
  highestAssignedOffset(): number {
    const maxRow = Number(
      this.ctx.storage.sql.exec("SELECT max(offset) AS o FROM events").one().o ?? 0,
    );
    const seqRow = this.ctx.storage.sql
      .exec("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
      .toArray();
    const seq = seqRow.length ? Number(seqRow[0].seq) : 0;
    return Math.max(maxRow, seq);
  }

  count(): number {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM events").one().n);
  }

  #byIdempotencyKey(key: string): StreamEvent | undefined {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT offset, type, created_at, idempotency_key, ephemeral, payload, metadata, source FROM events WHERE idempotency_key = ? LIMIT 1",
        key,
      )
      .toArray();
    return rows.length ? this.#hydrate(rows[0]) : undefined;
  }

  #row(offset: number): StreamEvent | undefined {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT offset, type, created_at, idempotency_key, ephemeral, payload, metadata, source FROM events WHERE offset = ? LIMIT 1",
        offset,
      )
      .toArray();
    return rows.length ? this.#hydrate(rows[0]) : undefined;
  }

  #hydrate(r: Record<string, unknown>): StreamEvent {
    const parse = (v: unknown) => (v === null ? undefined : (JSON.parse(String(v)) ?? undefined));
    return {
      offset: Number(r.offset),
      type: String(r.type),
      createdAt: String(r.created_at), // ISO string (canonical contract)
      path: this.#path,
      idempotencyKey: r.idempotency_key === null ? undefined : String(r.idempotency_key),
      ephemeral: Number(r.ephemeral) === 1 ? true : undefined, // contract: `true | undefined`, never false
      payload: parse(r.payload),
      metadata: parse(r.metadata),
      source: parse(r.source),
    } as unknown as StreamEvent;
  }

  // Date.now() is fine inside a DO (not a workflow); isolate a single call site.
  #now(): number {
    return Date.now();
  }
}
