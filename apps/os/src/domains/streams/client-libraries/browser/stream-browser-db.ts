export type SqlValue = string | number | bigint | Uint8Array | number[] | null;

export type StreamEventRow = {
  local_index: number;
  offset: number;
  type: string;
  idempotency_key: string | null;
  created_at: string;
  inserted_at: string;
  raw_json: string;
};

export type StreamDatabaseInfo = {
  databaseSizeBytes: number;
  storageType: "opfs";
  persisted: boolean;
  crossOriginIsolated: boolean;
};

export type StreamDatabaseEventSummary = {
  count: number;
  minOffset: number | null;
  maxOffset: number | null;
  isContinuous: boolean;
};

export type SqliteQueryStatus = "pending" | "ok" | "error";

export type SqliteQuerySnapshot<T> = {
  data: T[];
  status: SqliteQueryStatus;
  error: Error | undefined;
};

export type SqliteQueryHandle = {
  getSnapshot(): SqliteQuerySnapshot<Record<string, SqlValue>>;
  subscribe(listener: () => void): () => void;
};

export type SqlClient = {
  exec(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]>;
  batch(
    statements: { sql: string; params?: SqlValue[] }[],
    options?: { transaction?: boolean },
  ): Promise<void>;
};

type StreamDbChange = { kind: "append"; minOffset: number; maxOffset: number } | { kind: "clear" };

type RegisteredQuery = {
  sql: string;
  params: SqlValue[];
  snapshot: SqliteQuerySnapshot<Record<string, SqlValue>>;
  started: boolean;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  readonly listeners: Set<() => void>;
  readonly handle: SqliteQueryHandle;
};

const PENDING: SqliteQuerySnapshot<never> = { data: [], status: "pending", error: undefined };

export class StreamBrowserDatabase implements Disposable {
  readonly databasePath: string;
  readonly downloadFilename: string;
  readonly #worker: Worker;
  readonly #channel: BroadcastChannel;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: this field is only ever read via `await this.#ready`, which the rule does not count as a use.
  readonly #ready: Promise<void>;
  #nextRequestId = 1;
  #disposed = false;
  #infoRefresh: Promise<StreamDatabaseInfo> | undefined;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #queries = new Map<string, RegisteredQuery>();
  // Every entry a view is (or was) observing. Change notifications iterate
  // THIS set, not #queries: the dedupe map can evict/replace an entry while a
  // view still holds its handle, and that view must keep refreshing.
  readonly #liveQueries = new Set<RegisteredQuery>();
  readonly #changeListeners = new Set<(change: StreamDbChange) => void>();

  constructor(
    readonly projectId: string,
    readonly streamPath: string,
  ) {
    this.databasePath = databasePathFor(projectId, streamPath);
    this.downloadFilename = downloadFilenameFor(projectId, streamPath);
    this.#worker = new Worker(new URL("./stream-db.worker.ts", import.meta.url), {
      type: "module",
    });
    this.#worker.onmessage = (
      event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>,
    ) => {
      const { id, ok, result, error } = event.data;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error ?? "stream db worker error"));
    };
    // The cache version namespaces the channel too: a tab from an older deploy
    // mirrors the same stream into a different OPFS file, and its change
    // notifications must not re-run this mirror's queries (or vice versa).
    this.#channel = new BroadcastChannel(
      `stream-db:${DATABASE_CACHE_VERSION}:${encodeURIComponent(projectId)}:${encodeURIComponent(streamPath)}`,
    );
    this.#channel.onmessage = (event: MessageEvent<StreamDbChange>) => this.#onChange(event.data);
    this.#ready = this.#call("init", { databasePath: this.databasePath }).then(() => undefined);
  }

  #assertOpen() {
    if (this.#disposed) throw new Error("stream browser database is disposed");
  }

  #call(op: string, args: Record<string, unknown>): Promise<unknown> {
    this.#assertOpen();
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, op, ...args });
    });
  }

  async exec(sql: string, params: SqlValue[] = []): Promise<Record<string, SqlValue>[]> {
    await this.#ready;
    return await this.#execReady(sql, params);
  }

  async #execReady(sql: string, params: SqlValue[] = []): Promise<Record<string, SqlValue>[]> {
    const rows = await this.#call("exec", { sql, params });
    if (!Array.isArray(rows)) throw new Error("stream db worker returned non-array exec result");
    return rows.filter(isSqlRow);
  }

  async batch(
    statements: { sql: string; params?: SqlValue[] }[],
    options: { transaction?: boolean } = {},
  ): Promise<void> {
    await this.#ready;
    await this.#call("batch", { statements, transaction: options.transaction ?? false });
  }

  async maxOffset(): Promise<number> {
    if (!(await this.#eventsTableExists())) return -1;
    const [row] = await this.exec(`SELECT MAX(offset) AS max_offset FROM events`);
    return Number(row?.max_offset ?? -1);
  }

  async eventSummary(): Promise<StreamDatabaseEventSummary> {
    if (!(await this.#eventsTableExists())) {
      return { count: 0, minOffset: null, maxOffset: null, isContinuous: true };
    }
    const [row] = await this.exec(
      `SELECT COUNT(*) AS event_count, MIN(offset) AS min_offset, MAX(offset) AS max_offset
       FROM events`,
    );
    const count = Number(row?.event_count ?? 0);
    const minOffset =
      row?.min_offset === null || row?.min_offset === undefined ? null : Number(row.min_offset);
    const maxOffset =
      row?.max_offset === null || row?.max_offset === undefined ? null : Number(row.max_offset);

    return {
      count,
      minOffset,
      maxOffset,
      isContinuous: count === 0 || (minOffset === 1 && maxOffset === count),
    };
  }

  notifyChanged(change: StreamDbChange = { kind: "append", minOffset: 0, maxOffset: 0 }) {
    this.#publishChange(change);
  }

  async info(): Promise<StreamDatabaseInfo> {
    this.#infoRefresh ??= (async () => {
      try {
        const persisted = (await navigator.storage?.persisted?.()) ?? false;
        const [size] = await this.exec(
          `SELECT page_count * page_size AS bytes
           FROM pragma_page_count(), pragma_page_size()`,
        );
        return {
          databaseSizeBytes: Number(size?.bytes ?? 0),
          storageType: "opfs",
          persisted,
          crossOriginIsolated: globalThis.crossOriginIsolated,
        };
      } finally {
        this.#infoRefresh = undefined;
      }
    })();
    return this.#infoRefresh;
  }

  async download() {
    await this.#ready;
    const buffer = await this.#call("export", {});
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error("stream db worker returned non-ArrayBuffer export result");
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/x-sqlite3" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = this.downloadFilename;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Clears the given tables (those that exist) and broadcasts a clear so views remount. */
  async clearTables(tables: readonly string[]) {
    for (const table of tables) {
      if (await this.#tableExists(table)) await this.exec(`DELETE FROM ${table}`);
    }
    this.#publishChange({ kind: "clear" });
  }

  async compact() {
    await this.exec(`VACUUM`);
  }

  /**
   * The server stream incarnation (its `created` identity) this mirror was last built
   * against, or undefined if never recorded. Used to detect a server reset()/reincarnation
   * so the mirror is rebuilt rather than reconciled by an offset that restarted.
   *
   * Keyed per processor slug: multiple runtimes share this database and each
   * reconciles (and discards) its own tables independently — a shared key would
   * let the first runtime's rebuild mask another runtime's pending discard.
   */
  async readMirrorIncarnation(slug: string): Promise<string | undefined> {
    await this.#ensureMirrorMetaSchema();
    const [row] = await this.exec(`SELECT value FROM mirror_meta WHERE key = ? LIMIT 1`, [
      `incarnation:${slug}`,
    ]);
    return typeof row?.value === "string" ? row.value : undefined;
  }

  async writeMirrorIncarnation(slug: string, incarnation: string): Promise<void> {
    await this.#ensureMirrorMetaSchema();
    await this.exec(
      `INSERT INTO mirror_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`incarnation:${slug}`, incarnation],
    );
  }

  async readMirrorSchemaVersion(slug: string): Promise<number | undefined> {
    await this.#ensureMirrorMetaSchema();
    const [row] = await this.exec(`SELECT value FROM mirror_meta WHERE key = ? LIMIT 1`, [
      `schema-version:${slug}`,
    ]);
    if (typeof row?.value !== "string") return undefined;
    const version = Number(row.value);
    return Number.isFinite(version) ? version : undefined;
  }

  async writeMirrorSchemaVersion(slug: string, schemaVersion: number): Promise<void> {
    await this.#ensureMirrorMetaSchema();
    await this.exec(
      `INSERT INTO mirror_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`schema-version:${slug}`, String(schemaVersion)],
    );
  }

  async #ensureMirrorMetaSchema(): Promise<void> {
    await this.exec(
      `CREATE TABLE IF NOT EXISTS mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  }

  query(sql: string, params: SqlValue[]): SqliteQueryHandle {
    const key = `${sql}\0${JSON.stringify(params)}`;
    const existing = this.#queries.get(key);
    if (existing !== undefined) return existing.handle;
    // The visible-range query changes on every virtual scroll range. Seed a new
    // range query with the previous successful result for the same SQL shape so
    // the feed does not briefly render an all-pending window while SQLite catches up.
    const previousSnapshot = [...this.#queries.values()].find(
      (query) => query.sql === sql && query.snapshot.status === "ok",
    )?.snapshot;

    const entry: RegisteredQuery = {
      sql,
      params,
      snapshot:
        previousSnapshot === undefined
          ? PENDING
          : { ...previousSnapshot, status: "pending", error: undefined },
      started: false,
      gcTimer: undefined,
      listeners: new Set(),
      handle: {
        getSnapshot: () => entry.snapshot,
        subscribe: (listener) => {
          entry.listeners.add(listener);
          if (entry.gcTimer !== undefined) {
            clearTimeout(entry.gcTimer);
            entry.gcTimer = undefined;
          }
          // React can subscribe AFTER the creation-time GC fired (Suspense or a
          // lazy chunk delays the commit past the 0ms timer while useMemo keeps
          // the handle). An evicted entry must rejoin the registry, or this
          // query runs once and never sees another change notification — the
          // exact "feed frozen until reload" bug. The dedupe slot may have been
          // re-taken by a newer identical entry; #liveQueries is what change
          // notification iterates, so re-adding there is what matters.
          if (this.#queries.get(key) === undefined) this.#queries.set(key, entry);
          this.#liveQueries.add(entry);
          if (!entry.started) {
            entry.started = true;
            void this.#runQuery(entry);
          }
          return () => {
            entry.listeners.delete(listener);
            if (entry.listeners.size > 0) return;
            this.#armQueryGc(key, entry);
          };
        },
      },
    };
    this.#queries.set(key, entry);
    // Arm GC at creation too: a `query()` whose handle is read for a snapshot but never
    // subscribed (e.g. a render that unmounts before useSyncExternalStore subscribes)
    // would otherwise leak in `#queries` forever. subscribe() cancels this timer.
    this.#armQueryGc(key, entry);
    return entry.handle;
  }

  #armQueryGc(key: string, entry: RegisteredQuery) {
    if (entry.gcTimer !== undefined) clearTimeout(entry.gcTimer);
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = undefined;
      if (entry.listeners.size === 0) {
        this.#liveQueries.delete(entry);
        if (this.#queries.get(key) === entry) this.#queries.delete(key);
      }
    }, 0);
  }

  onChange(listener: (change: StreamDbChange) => void) {
    this.#changeListeners.add(listener);
    return () => void this.#changeListeners.delete(listener);
  }

  async #runQuery(entry: RegisteredQuery): Promise<void> {
    const previous = entry.snapshot;
    let next: SqliteQuerySnapshot<Record<string, SqlValue>>;
    try {
      const data = await this.exec(entry.sql, entry.params);
      next = { data, status: "ok", error: undefined };
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table")) {
        // A view's table may not exist until its processor's first write creates it. Treat
        // that as an empty result (count 0 / no rows) rather than a surfaced error.
        next = { data: emptyTableRows(entry.sql), status: "ok", error: undefined };
      } else {
        console.error(`[stream-browser-db ${this.streamPath}] SQLite query failed`, {
          error,
          params: entry.params,
          sql: entry.sql,
        });
        next = {
          ...entry.snapshot,
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
    entry.snapshot = next;
    // Skip notifying when the result is unchanged: useSyncExternalStore re-reads the
    // snapshot on every notify, so spurious notifications churn React re-renders even
    // though nothing the view sees changed.
    if (snapshotsEqual(previous, next)) return;
    for (const listener of entry.listeners) listener();
  }

  async #eventsTableExists(): Promise<boolean> {
    return this.#tableExists("events");
  }

  async #tableExists(name: string): Promise<boolean> {
    await this.#ready;
    const [row] = await this.#execReady(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [name],
    );
    return row !== undefined;
  }

  #publishChange(change: StreamDbChange) {
    this.#channel.postMessage(change);
    this.#onChange(change);
  }

  #onChange(change: StreamDbChange) {
    this.#infoRefresh = undefined;
    for (const entry of this.#liveQueries) {
      // Skip entries no view is observing (and ones that never started): re-running them
      // wastes a worker round trip and they will run on first subscribe anyway.
      if (entry.listeners.size === 0 || !entry.started) continue;
      void this.#runQuery(entry);
    }
    for (const listener of this.#changeListeners) listener(change);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("stream browser database disposed"));
    }
    this.#pending.clear();
    this.#queries.clear();
    this.#liveQueries.clear();
    this.#changeListeners.clear();
    this.#channel.close();
    const closeRequestId = this.#nextRequestId++;
    const onCloseMessage = (event: MessageEvent<{ id: number }>) => {
      if (event.data.id !== closeRequestId) return;
      clearTimeout(terminateTimer);
      this.#worker.removeEventListener("message", onCloseMessage);
      this.#worker.terminate();
    };
    const terminateTimer = setTimeout(() => {
      this.#worker.removeEventListener("message", onCloseMessage);
      this.#worker.terminate();
    }, 10_000);
    this.#worker.addEventListener("message", onCloseMessage);
    this.#worker.postMessage({ id: closeRequestId, op: "close" });
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

// OPFS layout: one folder per projectId, one SQLite file per stream path inside it.
// Bump this when the local mirror file itself can be wedged by browser OPFS state;
// the mirror is a cache and will be replayed from the durable stream.
// "v4" is the itx namespace: legacy-engine mirrors on the same origin
// live under "v3", so the two engines can never open (or clear) each other's files.
const DATABASE_CACHE_VERSION = "v4";

/** OPFS directory path for the cached SQLite mirror of one stream. */
function databasePathFor(projectId: string, streamPath: string) {
  return `${encodeURIComponent(projectId)}/${DATABASE_CACHE_VERSION}/${databaseSlugForStreamPath(streamPath)}.sqlite3`;
}

/** Download filename paired with databasePathFor's project/version/stream identity. */
function downloadFilenameFor(projectId: string, streamPath: string) {
  return `${encodeURIComponent(projectId)}__${DATABASE_CACHE_VERSION}-${databaseSlugForStreamPath(streamPath)}.sqlite3`;
}

function databaseSlugForStreamPath(streamPath: string) {
  const segments = streamPath.split("/").filter(Boolean).map(encodeURIComponent);
  const hint = segments.at(-1) ?? "root";
  return `stream-${fnv1a32(streamPath).toString(16).padStart(8, "0")}-${hint.slice(0, 24)}`;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function isSqlRow(value: unknown): value is Record<string, SqlValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isSqlValue);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array ||
    (Array.isArray(value) && value.every((item) => typeof item === "number"))
  );
}

/**
 * Structural equality for query snapshots, used to suppress redundant listener
 * notifications. Rows are plain `Record<string, SqlValue>` objects, so a stable JSON
 * serialization of the `data` array is a sufficient and cheap deep comparison (values are
 * strings/numbers/bigint/null or numeric arrays; column order is stable for a fixed query).
 */
function snapshotsEqual(
  a: SqliteQuerySnapshot<Record<string, SqlValue>>,
  b: SqliteQuerySnapshot<Record<string, SqlValue>>,
): boolean {
  if (a === b) return true;
  if (a.status !== b.status) return false;
  if (a.error !== b.error) return false;
  if (a.data === b.data) return true;
  if (a.data.length !== b.data.length) return false;
  return serializeRows(a.data) === serializeRows(b.data);
}

function serializeRows(rows: Record<string, SqlValue>[]): string {
  return JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? `__bigint__${value.toString()}` : value,
  );
}

function emptyTableRows(sql: string): Record<string, SqlValue>[] {
  // A `SELECT COUNT(*) AS count ...` over a not-yet-created table reads as 0; anything else
  // reads as no rows.
  return /^\s*SELECT\s+COUNT\(\*\)\s+AS\s+count\b/i.test(sql) ? [{ count: 0 }] : [];
}
