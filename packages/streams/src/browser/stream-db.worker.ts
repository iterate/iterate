/// <reference lib="webworker" />
// Per-tab dedicated worker that owns ONE wa-sqlite connection to the stream's OPFS
// database, using the OPFSCoopSyncVFS VFS. That VFS needs no SharedArrayBuffer, no
// COOP/COEP, and no async-proxy worker (the things that deadlocked SQLocal's default
// "opfs" VFS in production builds); it cooperatively shares the OPFS file across the
// per-tab connections of every open tab, so each tab reads locally and only ONE tab
// (elected via Web Locks on the main thread) writes.
//
// This worker is intentionally generic: it speaks `exec` / `batch` / `export`. Table
// schemas are owned by browser stream processors and run through the same `exec` /
// `batch` surface on the main thread.
import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite.mjs";
import wasmUrl from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url";
import { Factory } from "@journeyapps/wa-sqlite";
import {
  SQLITE_BUSY,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_READWRITE,
  SQLITE_ROW,
} from "@journeyapps/wa-sqlite/src/sqlite-constants.js";
import { OPFSCoopSyncVFS } from "@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js";

type Sqlite3 = ReturnType<typeof Factory>;
// Matches wa-sqlite's SQLiteCompatibleType (blobs surface as Uint8Array or number[]).
type SqlValue = string | number | bigint | Uint8Array | number[] | null;
type Statement = { sql: string; params?: SqlValue[] };
type Request =
  | { id: number; op: "init"; databasePath: string }
  | { id: number; op: "exec"; sql: string; params?: SqlValue[] }
  | { id: number; op: "batch"; statements: Statement[]; transaction: boolean }
  | { id: number; op: "export" }
  | { id: number; op: "close" };

let sqlite3: Sqlite3 | undefined;
let db: number | undefined;
let databasePath = "";
const VFS_NAME = "stream-opfs-coop";

async function open(path: string): Promise<void> {
  const module = await loadSqliteModule();
  sqlite3 = Factory(module);
  const vfs = await OPFSCoopSyncVFS.create(VFS_NAME, module);
  // wa-sqlite's VFS base defaults to 64-byte pathnames. OS project namespaces are
  // longer than the example app's "default" namespace, so root stream DB paths can
  // exceed that and make sqlite3_open_v2 fail before OPFS is touched.
  vfs.mxPathname = 1024;
  // makeDefault:false — register under a name and pass it to open_v2, so we never touch
  // the built-in "opfs"/"memory" VFS registration.
  sqlite3.vfs_register(vfs, false);
  databasePath = path;
  db = await openWithRetry(path);
  // NOTE: deliberately NO `PRAGMA busy_timeout`. OPFSCoopSyncVFS acquires its OPFS access
  // handle asynchronously and pushes that onto wa-sqlite's `retryOps`, which sqlite3.exec/
  // statements await and then retry — so the first lock resolves in ~one event-loop turn.
  // A busy_timeout would instead make SQLite's core spin synchronously (blocking the event
  // loop, so the async acquisition can't resolve) for the whole timeout — a ~5s stall on
  // first open. Cross-connection contention is handled by withBusyRetry instead.
}

async function loadSqliteModule() {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch SQLite WASM: ${String(response.status)} ${response.statusText}`,
    );
  }
  return await SQLiteESMFactory({
    locateFile: () => wasmUrl,
    wasmBinary: await response.arrayBuffer(),
  });
}

async function openWithRetry(path: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    try {
      if (sqlite3 === undefined) throw new Error("sqlite not initialised");
      return await sqlite3.open_v2(path, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, VFS_NAME);
    } catch (error) {
      lastError = error;
      // In split views a disposed OPFSCoopSyncVFS connection can still be handing off
      // its access handle while the replacement pane opens another DB. wa-sqlite can
      // surface that as transient OPFS "file or directory could not be found"; retry
      // open long enough to avoid turning the handoff into a permanent loading error.
      // The split-view disposal Playwright spec repeats this race.
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 10 * 2 ** attempt)));
    }
  }
  throw new Error(`sqlite3_open_v2 failed for ${path}: ${errorMessage(lastError)}`);
}

/** Runs one statement, collecting any result rows as plain objects. */
async function exec(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
  if (sqlite3 === undefined || db === undefined) throw new Error("db not initialised");
  const rows: Record<string, SqlValue>[] = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params !== undefined && params.length > 0) sqlite3.bind_collection(stmt, params);
    const columns = sqlite3.column_names(stmt);
    while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
      const values = sqlite3.row(stmt);
      const row: Record<string, SqlValue> = {};
      columns.forEach((name, i) => (row[name] = values[i] ?? null));
      rows.push(row);
    }
  }
  return rows;
}

async function batch(statements: Statement[], transaction: boolean): Promise<void> {
  if (sqlite3 === undefined || db === undefined) throw new Error("db not initialised");
  if (transaction) await sqlite3.exec(db, "BEGIN IMMEDIATE;");
  try {
    for (const statement of statements) await exec(statement.sql, statement.params);
    if (transaction) await sqlite3.exec(db, "COMMIT;");
  } catch (error) {
    if (transaction) await sqlite3.exec(db, "ROLLBACK;");
    throw error;
  }
}

// wa-sqlite's own retryOps resolves the FIRST (async) handle acquisition. This handles the
// other case: genuine contention when another tab's connection currently holds the OPFS
// access handle. We retry the whole op with a short backoff, yielding the event loop so the
// cooperative handoff (BroadcastChannel) can complete. Bounded so a real error still surfaces.
async function withBusyRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isBusyError(error) || attempt >= 25) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, 2 ** attempt)));
    }
  }
}

function isBusyError(error: unknown) {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === SQLITE_BUSY
  );
}

async function exportFile(): Promise<ArrayBuffer> {
  // OPFSCoopSyncVFS stores a real, transparent SQLite file in OPFS; read it back raw.
  const root = await navigator.storage.getDirectory();
  const segments = databasePath.split("/").filter(Boolean);
  let dir = root;
  for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
  const handle = await dir.getFileHandle(segments.at(-1) ?? databasePath);
  return (await handle.getFile()).arrayBuffer();
}

async function closeDatabase(): Promise<void> {
  if (sqlite3 !== undefined && db !== undefined) {
    await sqlite3.close(db);
  }
  db = undefined;
  sqlite3 = undefined;
  databasePath = "";
}

async function handle(request: Request): Promise<unknown> {
  switch (request.op) {
    case "init":
      await open(request.databasePath);
      return undefined;
    case "exec":
      return withBusyRetry(() => exec(request.sql, request.params));
    case "batch":
      return withBusyRetry(() => batch(request.statements, request.transaction));
    case "export":
      return exportFile();
    case "close":
      return closeDatabase();
  }
}

let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(
    () => respond(request),
    () => respond(request),
  );
};

async function respond(request: Request) {
  try {
    const result = await handle(request);
    // ArrayBuffer results are transferred to avoid a copy on the way back.
    const transfer = result instanceof ArrayBuffer ? [result] : [];
    self.postMessage({ id: request.id, ok: true, result }, { transfer });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
