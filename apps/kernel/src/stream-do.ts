import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// The STREAM Durable Object — the durable log (append/read), the first REAL runtime capability
// (kills the `processEvent` stub, review #10). One DO instance per (projectId, path); addressed by
// name `<projectId>::<path>` from the unforgeable projectId prop, so a project can never reach another's
// streams. SQLite-backed append-only log with a monotonic seq.
//
// NOTE ON REUSE: apps/os's real `StreamDurableObject` cannot import into this pure-play kernel — it's
// welded to `rpc-targets.ts` (7,667 LOC) + the full os Env (see wayfinder/reuse-feasibility.md). Its
// storage ENGINE (`stream-storage.ts`, ~1,750 LOC, clean) IS importable, but pulling it in drags the
// `sqlfu` + `iterate` workspace deps into the clean pure-play kernel. For proving the TOPOLOGY (the
// goal), a ~40-line native log is enough and keeps the kernel dependency-free. The engine reuse is a
// migration-time optimization, not needed to prove streams work across deployments.
// ---------------------------------------------------------------------------

export type StreamEvent = { seq: number; ts: number; type: string; data: unknown };

export class StreamDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, data TEXT)",
    );
  }

  // Append one event; returns its assigned seq. Durable — survives eviction/restart (SQLite on disk).
  append(type: string, data: unknown): number {
    const ts = this.#now();
    this.ctx.storage.sql.exec(
      "INSERT INTO log (ts, type, data) VALUES (?, ?, ?)",
      ts,
      type,
      JSON.stringify(data),
    );
    const row = this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS seq").one();
    return Number(row.seq);
  }

  // Read events with seq > fromSeq (the subscribe/replay primitive; poll-based for the spike).
  read(fromSeq = 0, limit = 1000): StreamEvent[] {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT seq, ts, type, data FROM log WHERE seq > ? ORDER BY seq LIMIT ?",
        fromSeq,
        limit,
      )
      .toArray();
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      type: String(r.type),
      data: JSON.parse(String(r.data)),
    }));
  }

  count(): number {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM log").one().n);
  }

  // Date.now() is fine inside a DO (not a workflow); isolate a single call site.
  #now(): number {
    return Date.now();
  }
}
