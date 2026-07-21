import type { CollabSnapshot, PersistedCollabOp } from "./collab-engine.ts";
import type { CollabSessionStore } from "./collab-host.ts";

/** In-memory CollabSessionStore mirroring the SQLite impl's semantics:
 * putSnapshot = snapshot upsert + covered-op prune + idempotent session
 * birth; append bumps head_version; endSession deletes everything. */
export function fakeSessionStore() {
  const ops = new Map<string, PersistedCollabOp[]>();
  const snapshots = new Map<string, CollabSnapshot>();
  const sessions = new Map<string, { epoch: string; head: number; overlay: number }>();
  const bases = new Map<string, { content: string; version: number }>();
  const prune = (path: string) => {
    const floor = Math.min(snapshots.get(path)?.version ?? 0, bases.get(path)?.version ?? 0);
    ops.set(
      path,
      (ops.get(path) ?? []).filter((op) => op.version >= floor),
    );
  };
  const store: CollabSessionStore = {
    append: async (path, epoch, batch) => {
      const session = sessions.get(path);
      if (session === undefined || session.epoch !== epoch) {
        throw new Error(`stale collab session for ${path} — reopen`);
      }
      ops.set(path, [...(ops.get(path) ?? []), ...structuredClone(batch)]);
      session.head = batch.at(-1)!.version + 1;
    },
    getSnapshot: async (path) => structuredClone(snapshots.get(path) ?? null),
    putSnapshot: async (path, snapshot) => {
      snapshots.set(path, structuredClone(snapshot));
      if (!sessions.has(path)) {
        sessions.set(path, {
          epoch: snapshot.epoch,
          head: snapshot.version,
          overlay: snapshot.version,
        });
      }
      if (!bases.has(path)) {
        bases.set(path, { content: snapshot.content, version: snapshot.version });
      }
      prune(path);
    },
    readOps: async (path, _epoch, afterVersion) =>
      structuredClone((ops.get(path) ?? []).filter((op) => op.version > afterVersion)),
    dirtySessions: () =>
      [...sessions.entries()].filter(([, row]) => row.head > row.overlay).map(([path]) => path),
    livePaths: () => [...sessions.keys()],
    hasSession: (path) => sessions.has(path),
    markFlushed: (path, version, epoch) => {
      const row = sessions.get(path);
      if (row && (epoch === undefined || row.epoch === epoch)) row.overlay = version;
    },
    setBases: (files) => {
      for (const file of files) {
        const row = sessions.get(file.path);
        if (row === undefined || row.epoch !== file.epoch) continue;
        bases.set(file.path, { content: file.content, version: file.version });
        prune(file.path);
      }
    },
    getBase: (path) => structuredClone(bases.get(path) ?? null),
    setBase: (path, base) => {
      bases.set(path, structuredClone(base));
      prune(path);
    },
    endSession: (path) => {
      sessions.delete(path);
      snapshots.delete(path);
      ops.delete(path);
      bases.delete(path);
    },
  };
  return { bases, ops, sessions, snapshots, store };
}
