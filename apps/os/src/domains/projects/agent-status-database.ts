import { AgentStatusRecord, mergeAgentStatusPatch } from "../agents/agent-processor-contract.ts";

/** One status-changed event as the fan-in hands it over: raw payload plus the
 * event's own offset (the redelivery guard) and createdAt (recency). */
export type AgentStatusTouchInput = {
  path: string;
  events: Array<{ payload: unknown; offset: number; createdAt: string }>;
};

/** One row of the agents roster: an agent stream and its merged status record. */
export type AgentStatusRow = {
  path: string;
  /** The merged status record (mergeAgentStatusPatch over the agent's own
   * status-changed patches — same fold as the agent processor and the Slack
   * painter, so every surface agrees). */
  status: AgentStatusRecord;
  /** Offset of the last folded status-changed event — redelivered batches
   * fold to nothing past it. */
  lastEventOffset: number;
  /** createdAt of that event. */
  updatedAt: string;
};

/**
 * The project's agents roster — a materialized view of every agent stream's
 * merged status record, keyed by path. The sibling of StreamDatabase (same
 * file-level doctrine applies): PROJECT state the Durable Object maintains in
 * its own SQLite, fed from the `processEventBatch` fan-in, with an immutable
 * copy-on-write projection so `itx.liveState` diffs stay O(changed row). The
 * journal truth stays on each agent's own stream; a wiped row re-fills from
 * the agent's next status patch.
 */
export class AgentStatusDatabase {
  readonly #sql: SqlStorage;
  #projection: Record<string, AgentStatusRow>;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS agent_status (
        path TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_event_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
    this.#projection = this.#load();
  }

  /** The roster keyed by path — a STABLE reference between writes, so the diff bails out. */
  all(): Record<string, AgentStatusRow> {
    return this.#projection;
  }

  /**
   * Fold one delivered batch's status-changed events into the agent's row.
   * FULLY idempotent: events at or below the row's `lastEventOffset` fold to
   * nothing (offsets are stream-monotonic), payloads that fail the contract
   * schema are skipped, and a batch that changes nothing keeps the
   * projection's identity — no write, no live-state diff.
   */
  touch(input: AgentStatusTouchInput): void {
    const prev: AgentStatusRow | undefined = this.#projection[input.path];
    let status: AgentStatusRecord | undefined = prev?.status;
    let lastEventOffset = prev?.lastEventOffset ?? 0;
    let updatedAt = prev?.updatedAt;
    for (const event of input.events) {
      if (event.offset <= lastEventOffset) continue;
      lastEventOffset = event.offset;
      const parsed = AgentStatusRecord.safeParse(event.payload);
      if (!parsed.success) continue;
      const merged = mergeAgentStatusPatch(status, parsed.data);
      if (merged === status) continue;
      status = merged;
      updatedAt = event.createdAt;
    }
    if (status === undefined || updatedAt === undefined) return;
    if (prev !== undefined && status === prev.status && lastEventOffset === prev.lastEventOffset) {
      return;
    }
    const row: AgentStatusRow = { path: input.path, status, lastEventOffset, updatedAt };
    this.#store(row);
    this.#projection = { ...this.#projection, [input.path]: row };
  }

  /** Persist one merged row — REPLACE, because the merge already happened in JS. */
  #store(row: AgentStatusRow): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO agent_status (path, status, last_event_offset, updated_at)
       VALUES (?, ?, ?, ?)`,
      row.path,
      JSON.stringify(row.status),
      row.lastEventOffset,
      row.updatedAt,
    );
  }

  #load(): Record<string, AgentStatusRow> {
    const rows: Record<string, AgentStatusRow> = {};
    for (const row of this.#sql.exec(`SELECT * FROM agent_status`).toArray()) {
      const parsed = AgentStatusRecord.safeParse(JSON.parse(row.status as string));
      if (!parsed.success) continue;
      rows[row.path as string] = {
        path: row.path as string,
        status: parsed.data,
        lastEventOffset: Number(row.last_event_offset),
        updatedAt: row.updated_at as string,
      };
    }
    return rows;
  }
}
