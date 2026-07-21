import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates, type Update } from "@codemirror/collab";

/**
 * Server authority for per-file collaborative editing — the rebase model
 * (@codemirror/collab): one totally-ordered update log per live file, an
 * integer version = number of accepted updates, optimistic clients that
 * rebase unconfirmed changes over broadcasts. No CRDT: the confirmed
 * document is a pure fold of the log.
 *
 * Host-agnostic like WorkspaceCore: durability is injected via CollabStore,
 * whose `append` MUST resolve only once the batch is crash-durable. The ack
 * contract is apply → persist → ack → broadcast: an acknowledged update
 * survives any crash; a crash before persist loses only unacked ops, which
 * clients retry — idempotency (clientId, clientSeq) makes retries safe.
 *
 * The engine knows nothing about overlays or sessions-as-policy; the host
 * (collab-host.ts) owns seeding, settlement, lifecycle, and size policy
 * beyond the per-push caps enforced here.
 */

/** One accepted-and-persisted update; `changes` is ChangeSet JSON. */
export interface PersistedCollabOp {
  changes: unknown;
  clientId: string;
  clientSeq: number;
  version: number;
}

export interface CollabSnapshot {
  clientSeqs: Record<string, number>;
  content: string;
  epoch: string;
  version: number;
}

/**
 * Durability boundary. `append` resolves ⇒ the ops survive a crash.
 * `putSnapshot` is the compaction point: the host's implementation prunes
 * covered ops in the same transaction (the engine never re-reads them).
 */
export interface CollabStore {
  append(path: string, epoch: string, ops: PersistedCollabOp[]): Promise<void>;
  getSnapshot(path: string): Promise<CollabSnapshot | null>;
  putSnapshot(path: string, snapshot: CollabSnapshot): Promise<void>;
  /** Ops with version > afterVersion for the given epoch, ascending. */
  readOps(path: string, epoch: string, afterVersion: number): Promise<PersistedCollabOp[]>;
}

export interface CollabPush {
  baseVersion: number;
  clientId: string;
  epoch: string;
  ops: { changes: unknown; clientSeq: number }[];
  path: string;
}

export type CollabPushResult =
  | { status: "accepted"; version: number }
  | { status: "epoch-mismatch"; epoch: string }
  /** Base is older than retained history — client must snapshot-catch-up. */
  | { status: "history-miss" }
  /** Batch or resulting document exceeds the size policy. */
  | { status: "too-large"; maxBytes: number };

export type CollabPull =
  | { ops: { changes: unknown; clientId: string }[]; status: "ops" }
  | { snapshot: { content: string; epoch: string; version: number }; status: "snapshot" }
  /** The session was durably ended (deleted/replaced/reset) — reopen to resume. */
  | { status: "ended" };

export type CollabBroadcast = {
  epoch: string;
  fromVersion: number;
  ops: { changes: unknown; clientId: string }[];
  path: string;
  toVersion: number;
};

/** Whole-content replacement as a common-prefix/suffix splice — preserves
 * concurrent edits outside the changed region (null when nothing changed). */
export function minimalSplice(doc: Text, next: string): ChangeSet | null {
  const current = doc.toString();
  if (current === next) return null;
  let start = 0;
  const maxStart = Math.min(current.length, next.length);
  while (start < maxStart && current[start] === next[start]) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
    endCurrent--;
    endNext--;
  }
  return ChangeSet.of(
    { from: start, insert: next.slice(start, endNext), to: endCurrent },
    current.length,
  );
}

const SNAPSHOT_EVERY = 256;
/** Ops kept in memory for rebase/pull; older submissions get history-miss. */
const HISTORY_WINDOW = 1000;
// Dedupe identities are retained for the whole session: idempotency is a
// GUARANTEE, so identities retire only with the session/epoch lifecycle,
// never via an author-count LRU (evicting one would let a stale retry
// re-apply). Sessions end on destruction and idle sweep, bounding growth.
/** DO SQLite caps a cell at 2MB; one op's serialized changes must fit with
 * headroom (https://developers.cloudflare.com/durable-objects/platform/limits). */
export const MAX_PUSH_BYTES = 256 * 1024;
/** Documents past this never get (or grow) a live engine — the host refuses
 * opens, and pushes that would cross it are rejected. Matches the overlay's
 * own inline threshold zone under the same 2MB cell cap. */
export const MAX_DOC_BYTES = 1024 * 1024;

interface FileEngine {
  doc: Text;
  epoch: string;
  clientSeqs: Map<string, number>;
  opsSinceSnapshot: number;
  /** Ring of recent accepted ops (deserialized) for rebase + pull. */
  recent: { changes: ChangeSet; clientId: string; version: number }[];
  version: number;
  writeChain: Promise<unknown>;
}

export class CollabEngine {
  readonly #store: CollabStore;
  readonly #broadcast: (event: CollabBroadcast) => void;
  readonly #files = new Map<string, FileEngine | Promise<FileEngine>>();

  constructor(options: { broadcast?: (event: CollabBroadcast) => void; store: CollabStore }) {
    this.#store = options.store;
    this.#broadcast = options.broadcast ?? (() => {});
  }

  /**
   * Join a file's session, creating the engine on first open. `seed` supplies
   * the settled text and a fresh epoch when no persisted session exists;
   * recovery from a snapshot + op tail never consults it.
   */
  async open(
    path: string,
    seed: () => Promise<{ content: string; epoch: string }>,
  ): Promise<{ content: string; epoch: string; version: number }> {
    const file = await this.#ensure(path, seed);
    return { content: file.doc.toString(), epoch: file.epoch, version: file.version };
  }

  /** Accept a client batch: dedupe, rebase if stale, then the accept lane. */
  async push(input: CollabPush): Promise<CollabPushResult> {
    const file = await this.#live(input.path);
    const run = file.writeChain.then(() => this.#push(file, input));
    file.writeChain = run.catch(() => {});
    return await run;
  }

  async #push(file: FileEngine, input: CollabPush): Promise<CollabPushResult> {
    if (input.epoch !== file.epoch) return { epoch: file.epoch, status: "epoch-mismatch" };

    // Protocol validation at the door: sequences are strictly-ascending
    // non-negative integers, batches are bounded. A malformed batch is a
    // protocol error, never a partial application.
    if (input.ops.length > 256) throw new Error("push batch exceeds 256 ops");
    for (const [index, op] of input.ops.entries()) {
      if (!Number.isInteger(op.clientSeq) || op.clientSeq < 0) {
        throw new Error("clientSeq must be a non-negative integer");
      }
      if (index > 0 && op.clientSeq <= input.ops[index - 1]!.clientSeq) {
        throw new Error("clientSeq batch must be strictly ascending");
      }
    }

    // Full-duplicate fast path (retry after a lost ack with no news since).
    const seen = file.clientSeqs.get(input.clientId) ?? -1;
    if (input.ops.length === 0 || input.ops.at(-1)!.clientSeq <= seen) {
      return { status: "accepted", version: file.version };
    }

    const floor = file.version - file.recent.length;
    if (input.baseVersion < floor) return { status: "history-miss" };

    // Submit the WHOLE batch to rebaseUpdates: dropping the already-accepted
    // own-clientID prefix is its job, and it aligns that prefix positionally
    // against `over` — pre-filtering here breaks that alignment.
    let updates: readonly Update[] = input.ops.map((op) => ({
      changes: ChangeSet.fromJSON(op.changes),
      clientID: input.clientId,
    }));
    if (input.baseVersion < file.version) {
      // rebaseUpdates reads `clientID` (capital D) — mapped here so our wire
      // and storage keep one casing.
      const over = file.recent
        .slice(input.baseVersion - floor)
        .map((op) => ({ changes: op.changes, clientID: op.clientId }));
      updates = rebaseUpdates(updates, over);
    }

    // Whatever survived rebasing is the tail of the submission.
    const tail = input.ops.slice(input.ops.length - updates.length);
    return this.#accept(
      input.path,
      file,
      updates.map((update, index) => ({
        changes: update.changes,
        clientId: input.clientId,
        clientSeq: tail[index]!.clientSeq,
      })),
    );
  }

  /**
   * The agent/RPC door: compute a change against the CURRENT head inside the
   * write chain and accept it like any other update. This is what makes
   * `writeFile`/`edit` on a live path a collaborative splice instead of an
   * overlay stomp — the change can never race another accepted update.
   * Throws on a too-large result (the agent lane wants loud errors).
   */
  async applyExternal(
    path: string,
    compute: (doc: Text) => ChangeSet | null,
    author = "external",
  ): Promise<{ version: number }> {
    const file = await this.#live(path);
    const run = file.writeChain.then(async () => {
      const changes = compute(file.doc);
      if (changes === null) return { version: file.version };
      const result = await this.#accept(path, file, [
        // Version doubles as the seq: this lane writes at head, so uniqueness
        // is guaranteed and retries are the caller's concern.
        { changes, clientId: author, clientSeq: file.version },
      ]);
      if (result.status !== "accepted") {
        throw new Error(`external write rejected: ${result.status}`);
      }
      return { version: result.version };
    });
    file.writeChain = run.catch(() => {});
    return await run;
  }

  /** The one acceptance lane: size-check, apply, persist, mutate, broadcast. */
  async #accept(
    path: string,
    file: FileEngine,
    updates: { changes: ChangeSet; clientId: string; clientSeq: number }[],
  ): Promise<CollabPushResult> {
    if (updates.length === 0) return { status: "accepted", version: file.version };

    // Size gates BEFORE any application work: the serialized batch must fit
    // a SQLite cell, and the resulting doc must stay under the live cap.
    let bytes = 0;
    let growth = 0;
    const encoder = new TextEncoder();
    const jsons = updates.map((update) => {
      const json = update.changes.toJSON();
      // UTF-8 bytes, not UTF-16 units — the SQLite cell cap is a byte cap.
      bytes += encoder.encode(JSON.stringify(json)).length;
      growth += update.changes.newLength - update.changes.length;
      return json;
    });
    if (bytes > MAX_PUSH_BYTES) return { maxBytes: MAX_PUSH_BYTES, status: "too-large" };
    if (file.doc.length + growth > MAX_DOC_BYTES) {
      return { maxBytes: MAX_DOC_BYTES, status: "too-large" };
    }

    const persisted: PersistedCollabOp[] = [];
    let doc = file.doc;
    let version = file.version;
    for (const [index, update] of updates.entries()) {
      doc = update.changes.apply(doc);
      persisted.push({
        changes: jsons[index],
        clientId: update.clientId,
        clientSeq: update.clientSeq,
        version: version++,
      });
    }

    // Durability before ack; on failure nothing was applied and the client
    // retries the whole batch (idempotent via clientSeq).
    await this.#store.append(path, file.epoch, persisted);

    file.doc = doc;
    file.version = version;
    for (const [index, update] of updates.entries()) {
      file.clientSeqs.delete(update.clientId); // re-insert = LRU refresh
      file.clientSeqs.set(
        update.clientId,
        Math.max(file.clientSeqs.get(update.clientId) ?? -1, update.clientSeq),
      );
      file.recent.push({
        changes: update.changes,
        clientId: update.clientId,
        version: file.version - updates.length + index,
      });
    }
    if (file.recent.length > HISTORY_WINDOW) {
      file.recent.splice(0, file.recent.length - HISTORY_WINDOW);
    }

    file.opsSinceSnapshot += persisted.length;
    if (file.opsSinceSnapshot >= SNAPSHOT_EVERY) await this.#snapshot(path, file);

    this.#broadcast({
      epoch: file.epoch,
      fromVersion: file.version - persisted.length,
      ops: persisted.map((op) => ({ changes: op.changes, clientId: op.clientId })),
      path,
      toVersion: file.version,
    });
    return { status: "accepted", version: file.version };
  }

  /** Catch-up lane: ops after a version, or a snapshot when past the floor. */
  async pull(path: string, epoch: string, afterVersion: number): Promise<CollabPull> {
    const file = await this.#live(path);
    const floor = file.version - file.recent.length;
    if (epoch !== file.epoch || afterVersion < floor) {
      return {
        snapshot: { content: file.doc.toString(), epoch: file.epoch, version: file.version },
        status: "snapshot",
      };
    }
    return {
      ops: file.recent.slice(afterVersion - floor).map((op) => ({
        changes: op.changes.toJSON(),
        clientId: op.clientId,
      })),
      status: "ops",
    };
  }

  /** The live head, or null when no engine is in memory for the path. */
  head(path: string): { content: string; epoch: string; version: number } | null {
    const file = this.#files.get(path);
    if (file === undefined || file instanceof Promise) return null;
    return { content: file.doc.toString(), epoch: file.epoch, version: file.version };
  }

  /** Drop the in-memory engine WITHOUT snapshotting — for session end,
   * where the durable rows are being deleted and must not resurrect. */
  discard(path: string): void {
    this.#files.delete(path);
  }

  async #live(path: string): Promise<FileEngine> {
    const file = this.#files.get(path);
    if (file === undefined) throw new Error(`no live session for ${path} — open first`);
    return await file;
  }

  async #ensure(
    path: string,
    seed: () => Promise<{ content: string; epoch: string }>,
  ): Promise<FileEngine> {
    // The in-flight promise IS the map entry: concurrent opens join one boot
    // (racing boots would mint two epochs and collide on version PKs).
    const existing = this.#files.get(path);
    if (existing !== undefined) return await existing;
    const booting = this.#boot(path, seed);
    this.#files.set(path, booting);
    try {
      const file = await booting;
      this.#files.set(path, file);
      return file;
    } catch (error) {
      this.#files.delete(path);
      throw error;
    }
  }

  async #boot(
    path: string,
    seed: () => Promise<{ content: string; epoch: string }>,
  ): Promise<FileEngine> {
    const snapshot = await this.#store.getSnapshot(path);
    if (snapshot === null) {
      const seeded = await seed();
      const file = fileEngine(seeded.content, seeded.epoch, 0);
      await this.#snapshot(path, file);
      return file;
    }
    const file = fileEngine(snapshot.content, snapshot.epoch, snapshot.version);
    file.clientSeqs = new Map(Object.entries(snapshot.clientSeqs));
    for (const op of await this.#store.readOps(path, snapshot.epoch, snapshot.version - 1)) {
      const changes = ChangeSet.fromJSON(op.changes);
      file.doc = changes.apply(file.doc);
      file.recent.push({ changes, clientId: op.clientId, version: op.version });
      file.clientSeqs.set(
        op.clientId,
        Math.max(file.clientSeqs.get(op.clientId) ?? -1, op.clientSeq),
      );
      file.version = op.version + 1;
    }
    file.opsSinceSnapshot = file.recent.length;
    return file;
  }

  async #snapshot(path: string, file: FileEngine): Promise<void> {
    await this.#store.putSnapshot(path, {
      clientSeqs: Object.fromEntries(file.clientSeqs),
      content: file.doc.toString(),
      epoch: file.epoch,
      version: file.version,
    });
    file.opsSinceSnapshot = 0;
  }
}

function fileEngine(content: string, epoch: string, version: number): FileEngine {
  return {
    clientSeqs: new Map(),
    doc: Text.of(content.split("\n")),
    epoch,
    opsSinceSnapshot: 0,
    recent: [],
    version,
    writeChain: Promise.resolve(),
  };
}
