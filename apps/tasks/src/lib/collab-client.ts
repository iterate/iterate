import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import { ChangeSet, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { withProject, withProjectOnce } from "./use-checkout.ts";
import type { CollabChanges, CollabWaitResult, TasksWorkspace } from "./tasks-api.ts";

/**
 * The browser's end of the no-Yjs collab lane (PoC): @codemirror/collab's
 * rebase model over the vessel's capnweb `/api` — push batches out, long-poll
 * `wait` in. The server (the platform workspace DO) is the single ordering
 * authority; this client optimistically applies local edits and rebases
 * unconfirmed ones over every delivered batch.
 */
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "someone";

let displaySlug = "someone";
/** Redline tooltips say WHO — the display name rides inside the client id
 * (`u-<slug>-<rand>`), set once identity is known. */
export function setCollabDisplayName(name: string): void {
  displaySlug = slugify(name);
}

const freshClientId = () => `u-${displaySlug}-${Math.random().toString(36).slice(2, 8)}`;

export class CollabConnection {
  clientId = freshClientId();
  epoch = "";
  /** Own ops seen back in deliveries — the stable clientSeq base. */
  confirmed = 0;
  /** Fold of confirmed ops only — the reseed baseline for carrying
   * unconfirmed local edits across a snapshot re-sync. */
  onStatus: (status: string) => void = () => {};
  /** Set by the surface: rebuild the editor from a server snapshot. The
   * second argument is the text of genuinely UNACKED local edits (null when
   * recovery is clean) — surfaced for review, never silently merged. */
  onReseed: (
    snapshot: { ackedSeq: number; content: string; epoch: string; version: number },
    unsynced: string | null,
  ) => void = () => {};

  constructor(
    readonly checkoutId: string,
    readonly repoPath: string,
    readonly filePath: string,
  ) {}

  #lane(project: {
    workspace(checkoutId: string, repoPath?: string): unknown;
  }): TasksWorkspace {
    return project.workspace(this.checkoutId, this.repoPath) as TasksWorkspace;
  }

  async open(): Promise<{ content: string; version: number }> {
    // Identity first: the client id embeds the display name for attribution.
    this.clientId = freshClientId();
    const opened = await withProject((project) => this.#lane(project).open(this.filePath));
    this.epoch = opened.epoch;
    this.confirmed = 0;
    return opened;
  }

  async push(baseVersion: number, updates: readonly Update[]) {
    const ops = updates.map((update, index) => ({
      changes: update.changes.toJSON(),
      clientSeq: this.confirmed + index,
    }));
    return withProject((project) =>
      this.#lane(project).push({
        baseVersion,
        clientId: this.clientId,
        epoch: this.epoch,
        ops,
        path: this.filePath,
      }),
    );
  }

  /** One quiet try on the live session — never disposes the shared WS
   * (teardown flushes must not tear down the poll/wait loops). */
  async pushOnce(baseVersion: number, updates: readonly Update[]) {
    const ops = updates.map((update, index) => ({
      changes: update.changes.toJSON(),
      clientSeq: this.confirmed + index,
    }));
    return withProjectOnce((project) =>
      this.#lane(project).push({
        baseVersion,
        clientId: this.clientId,
        epoch: this.epoch,
        ops,
        path: this.filePath,
      }),
    );
  }

  async wait(afterVersion: number): Promise<CollabWaitResult> {
    return withProject((project) =>
      this.#lane(project).wait(this.filePath, this.epoch, afterVersion, this.clientId),
    );
  }

  async changes(): Promise<CollabChanges> {
    return withProject((project) => this.#lane(project).changes(this.filePath));
  }

  /** Fold delivered ops into the confirmed baseline and count own ones. */
  absorb(ops: { changes: unknown; clientId: string }[]): Update[] {
    this.confirmed += ops.filter((op) => op.clientId === this.clientId).length;
    const updates: Update[] = ops.map((op) => ({
      changes: ChangeSet.fromJSON(op.changes),
      clientID: op.clientId,
    }));
    return updates;
  }

  /** Reset the connection's confirmed baseline onto a server snapshot —
   * the bookkeeping half of a re-sync; the page rebuilds the editor. */
  reseed(snapshot: { content: string; epoch: string; version: number }): void {
    this.epoch = snapshot.epoch;
    this.confirmed = 0;
    // Fresh dedupe identity: same-epoch recovery restarts clientSeq at 0, and
    // the server has already acked the old (clientId, seq) pairs — reusing
    // them would silently drop every carried edit.
    this.clientId = freshClientId();
  }

}

const MAX_BACKOFF_MS = 10_000;
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);

/** The peer extension: collab state + the push/pull loops (official CM6
 * collab example shape, with capnweb long-poll as the transport). */
export function peerExtension(connection: CollabConnection, startVersion: number): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      pushing = false;
      done = false;
      failures = 0;
      /** Set on epoch-mismatch/history-miss: the pull loop's snapshot lane
       * owns recovery, and re-pushing before the reseed just spams a
       * rejection the server already gave. The reseed rebuilds the editor
       * (fresh plugin), so the flag's life ends with the stale state. */
      recovering = false;

      constructor(readonly view: EditorView) {
        void this.pull();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) void this.push();
      }

      async push(): Promise<void> {
        if (this.pushing || this.done || this.recovering) return;
        const updates = sendableUpdates(this.view.state);
        if (updates.length === 0) return;
        this.pushing = true;
        try {
          const result = await connection.push(getSyncedVersion(this.view.state), updates);
          switch (result.status) {
            case "accepted":
              this.failures = 0;
              break;
            case "too-large":
              // The batch can never succeed; stop the session loudly rather
              // than retrying an impossible push forever.
              this.done = true;
              connection.onStatus(`edit too large (cap ${result.maxBytes} bytes) — reopen the file`);
              return;
            case "epoch-mismatch":
            case "history-miss":
              this.recovering = true;
              break;
          }
        } catch (error) {
          this.failures++;
          connection.onStatus(`push retry ${this.failures}: ${message(error)}`);
          await sleep(backoff(this.failures));
        }
        this.pushing = false;
        // Anything typed while the push was in flight goes in the next batch.
        if (!this.done && !this.recovering && sendableUpdates(this.view.state).length > 0) {
          setTimeout(() => void this.push(), 120);
        }
      }

      async pull(): Promise<void> {
        while (!this.done) {
          try {
            const result = await connection.wait(getSyncedVersion(this.view.state));
            if (this.done) break;
            this.failures = 0;
            if (result.status === "ended") {
              // The file was deleted/replaced/reset: the session is gone for
              // everyone. Surface it and stop — reopening is a page decision.
              this.done = true;
              connection.onStatus("session ended (file deleted or replaced)");
              return;
            }
            if (result.status === "snapshot") {
              // Past the floor or epoch rotated. The server tells us exactly
              // which of our unconfirmed ops it accepted (ackedSeq); those
              // are IN the snapshot already. Whatever remains is genuinely
              // unacked — its inserted text is surfaced for the user, never
              // guessed into other people's document.
              const unconfirmed = sendableUpdates(this.view.state);
              const ackedCount = Math.max(0, result.snapshot.ackedSeq - connection.confirmed + 1);
              const unacked = unconfirmed.slice(ackedCount);
              let lost = "";
              for (const update of unacked) {
                update.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
                  if (text.length > 0) lost += (lost === "" ? "" : "\n") + text.toString();
                });
              }
              this.done = true;
              connection.onReseed(result.snapshot, lost === "" ? null : lost);
              return;
            }
            if (result.ops.length === 0) continue;
            this.view.dispatch(receiveUpdates(this.view.state, connection.absorb(result.ops)));
            if (this.recovering) {
              // History was intact after all — catching up via ops advanced
              // our base past the miss, so pushing can resume (the snapshot
              // lane only handles the truly-lost case).
              this.recovering = false;
              void this.push();
            }
          } catch (error) {
            if (this.done) break;
            this.failures++;
            if (this.failures > 8) {
              this.done = true;
              connection.onStatus(`disconnected: ${message(error)}`);
              return;
            }
            connection.onStatus(`reconnecting (${this.failures})…`);
            await sleep(backoff(this.failures));
          }
        }
      }

      destroy() {
        // Best-effort final flush: unpushed edits still in the doc would die
        // with the view (the board may already show them via the live
        // reflector). Safe to fire even beside an in-flight push — the
        // server dedupes by (clientId, clientSeq).
        if (!this.done && !this.recovering) {
          const pending = sendableUpdates(this.view.state);
          if (pending.length > 0) {
            // ONE quiet try on the live session: a failure here must never
            // dispose the shared WS (withProject's retry would), which was
            // tearing down the poll/wait loops on every editor remount.
            void connection.pushOnce(getSyncedVersion(this.view.state), pending).catch(() => {});
          }
        }
        this.done = true;
      }
    },
  );
  return [collab({ clientID: connection.clientId, startVersion }), plugin];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
