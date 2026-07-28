// One shared OPFS SQLite database per (projectId, streamPath): every runtime and
// view of a stream shares one wa-sqlite worker. Refcounted by the runtimes
// holding it; the database is disposed when the last one releases.

import { StreamBrowserDatabase } from "./stream-browser-db.ts";

const databaseRegistry = new Map<string, { db: StreamBrowserDatabase; refs: number }>();

export function acquireDatabase(
  projectId: string,
  streamPath: string,
): { db: StreamBrowserDatabase; release: () => void } {
  const key = `${projectId}\0${streamPath}`;
  let entry = databaseRegistry.get(key);
  if (entry === undefined) {
    entry = { db: new StreamBrowserDatabase(projectId, streamPath), refs: 0 };
    databaseRegistry.set(key, entry);
  }
  entry.refs += 1;
  const held = entry;
  return {
    db: held.db,
    release() {
      held.refs -= 1;
      if (held.refs === 0) {
        held.db.dispose();
        databaseRegistry.delete(key);
      }
    },
  };
}
