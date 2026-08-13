import { Text } from "@codemirror/state";
import { attributedChanges } from "@iterate-com/workspace-documents/attribution";
import { countOccurrences, replaceLiteralOccurrences } from "../repos/edit-utils.ts";
import { resolveAbsolutePath } from "./paths.ts";
import type { EditWorkspaceFileInput, EditWorkspaceFileResult } from "./types.ts";
import {
  CollabEngine,
  type CollabBroadcast,
  MAX_DOC_BYTES,
  minimalSplice,
  type CollabPresence,
  type CollabPull,
  type CollabPush,
  type CollabPushResult,
  type CollabStore,
} from "./collab-engine.ts";

/**
 * The workspace's collaborative-session coordinator: everything between the
 * pure engine and the Durable Object.
 *
 * The load-bearing idea (the reviews' "code judo"): **liveness is durable
 * state, not memory**. `collab_sessions` records every session with its
 * `head_version` (bumped atomically with each accepted append) and
 * `overlay_version` (bumped when that head settles into the overlay). Every
 * routing decision consults the durable set; `reconcile()` — the single
 * barrier primitive run before status/commit/configure — flushes every
 * session whose head is ahead, REGARDLESS of what this incarnation has in
 * memory. Debounce timers are purely a latency optimization: losing them to
 * eviction costs nothing but staleness-until-the-next-barrier.
 *
 * Sessions end (durably, seeding fresh next time) on destructive ops
 * (delete/byte-write/reset/revert) and on the idle sweep once clean —
 * a session is never a permanent shadow of the settled file.
 */

/** What the host needs from WorkspaceCore: seed reads and settle writes. */
export interface CollabSettledFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
}

/** CollabStore plus the durable session bookkeeping the host layers on. */
export interface CollabSessionStore extends CollabStore {
  /** Every durable session with its head and overlay versions — the ONE
   * routing/liveness/dirtiness read (dirty = head ahead of overlay). */
  sessions(): { headVersion: number; overlayVersion: number; path: string }[];
  /** Whether a durable session exists — one local-SQLite lookup. */
  hasSession(path: string): boolean;
  /** Record that `version` is settled into the overlay (epoch-conditional). */
  markFlushed(path: string, version: number, epoch?: string): void;
  /** ONE atomic transition for every baseline a commit stamps — partial
   * multi-file advancement after a crash is unrepresentable. Entries whose
   * session ended (or rotated epoch) are skipped, never mis-stamped. */
  setBases(files: { content: string; epoch: string; path: string; version: number }[]): void;
  /** The redline baseline: seed content at birth, re-stamped at each commit
   * (via setBases). Retention keeps ops back to this version, so tracked
   * changes are always reconstructable — the op log IS the redline data. */
  getBase(path: string): { content: string; version: number } | null;
  /** Delete the session, its snapshot, its ops, and its base — the durable end. */
  endSession(path: string): void;
}

/** Fresh caret presence as index-matched flat arrays (one entry per
 * path+client pair) — named so the generated capnweb surface references it
 * instead of structurally promise-mapping raw string arrays (illegal). */
export interface CollabPresenceFlat {
  clientIds: string[];
  paths: string[];
}

/** Attributed tracked changes since the last commit: author-tagged inserted
 * spans and deleted-text markers in current-head coordinates, plus the ONE
 * baseline both redline layers render against. */
export interface CollabChangesResult {
  baseContent: string;
  baseVersion: number;
  deleted: { at: number; clientId: string; createdAt?: number; text: string }[];
  headVersion: number;
  inserted: { clientId: string; createdAt?: number; from: number; to: number }[];
}

/** One settled file from a reconcile barrier — exactly what a commit that
 * follows the barrier will contain for that path. */
interface SettledFile {
  content: string;
  epoch: string;
  path: string;
  version: number;
}

const FLUSH_IDLE_MS = 2_000;
const FLUSH_MAX_MS = 15_000;
const WAIT_TIMEOUT_MS = 20_000;
const IDLE_END_MS = 5 * 60_000;
/** Cursor moves coalesce into one waiter wake per window — ten people
 * typing at once cost the session at most ten wakes a second, not one per
 * keystroke per person. */
const PRESENCE_WAKE_COALESCE_MS = 100;
/** A cursor nobody refreshed for this long belongs to a departed client. */
const PRESENCE_STALE_MS = 45_000;
/** Sweeps are periodic housekeeping, not per-keystroke work. */
const SWEEP_INTERVAL_MS = 60_000;
/** Ops retained since the last commit; past this, pushes refuse until a
 * commit prunes (redline work and storage stay bounded). */
const MAX_UNCOMMITTED_OPS = 10_000;

export class CollabHost {
  readonly #fs: CollabSettledFs;
  readonly #store: CollabSessionStore;
  readonly #engine: CollabEngine;
  // THE mutation coordinator: session lifecycle (open/end/sweep), settlement
  // (flush/reconcile), and settled-truth operations (status/configure/commit
  // via barrier()) all serialize here, so none of them can interleave — a
  // debounce flush can never land between a commit's barrier and its stamp,
  // and a configure can never re-route a session an open is still seeding.
  // Per-keystroke pushes deliberately stay on the per-file engine chains;
  // the store's epoch-CAS is their stale-work backstop.
  #chain: Promise<unknown> = Promise.resolve();

  #exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(job, job);
    this.#chain = run.catch(() => {});
    return run;
  }
  /** Bumped per durable end; open() re-checks it after its awaited seed so a
   * concurrent delete can never be resurrected by a slow-seeding open. */
  readonly #destroyed = new Map<string, number>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #flushTimers = new Map<string, { max: number; timer: ReturnType<typeof setTimeout> }>();
  readonly #lastActivity = new Map<string, number>();
  // Ephemeral cursor presence: per-path client map + a generation the wait
  // lane compares against, with one coalesced wake per change window.
  readonly #presence = new Map<string, Map<string, { anchor: number; at: number; head: number }>>();
  readonly #presenceGeneration = new Map<string, number>();
  readonly #presenceWake = new Map<string, ReturnType<typeof setTimeout>>();

  readonly #onBroadcast?: (event: CollabBroadcast) => void;

  constructor(options: {
    fs: CollabSettledFs;
    /** Observability tap: every accepted batch (live-edit pulse). */
    onBroadcast?: (event: CollabBroadcast) => void;
    store: CollabSessionStore;
  }) {
    this.#fs = options.fs;
    this.#store = options.store;
    this.#onBroadcast = options.onBroadcast;
    this.#engine = new CollabEngine({
      broadcast: (event) => {
        this.#wake(event.path);
        this.#scheduleFlush(event.path);
        this.#onBroadcast?.(event);
      },
      store: options.store,
    });
  }

  /** Session keys are FULLY RESOLVED absolute paths — `tasks/x.md`,
   * `//tasks/x.md`, and `/tasks/a/../x.md` must address ONE authority over
   * one file; two engines over one file would flush competing heads. */
  static canonical(path: string): string {
    return resolveAbsolutePath(path);
  }

  /** Liveness IS the durable session table — no in-memory mirror to drift. */
  isLive(path: string): boolean {
    return this.#store.hasSession(CollabHost.canonical(path));
  }

  /** Every durable session path — for listings and mount-transition sweeps. */
  livePaths(): string[] {
    return this.#store.sessions().map((session) => session.path);
  }

  /** The engine for a durable session, recovered lazily after eviction. */
  async #opened(path: string) {
    return this.#engine.open(path, () => {
      // A destructive end can land between a liveness check and this
      // recovery: rows gone ⇒ clean "reopen" signal, not corruption.
      if (!this.isLive(path)) throw new Error(`no live session for ${path} — open first`);
      throw new Error(`session for ${path} is durable but has no snapshot — store corruption`);
    });
  }

  // -- session lane ------------------------------------------------------------

  async open(rawPath: string): Promise<{ content: string; epoch: string; version: number }> {
    const path = CollabHost.canonical(rawPath);
    if (path === "/" || path.split("/").includes(".git")) {
      throw new Error(`cannot open a collaborative session on ${path}`);
    }
    this.#touch(path);
    if (this.isLive(path)) return this.#opened(path);
    // Capture the destruction generation BEFORE queueing on the coordinator:
    // a synchronous delete issued after this call but before the job runs
    // must still win against the birth.
    const destroyedBefore = this.#destroyed.get(path) ?? 0;
    return this.#exclusive(() => this.#openFresh(path, destroyedBefore));
  }

  async #openFresh(
    path: string,
    destroyedBefore: number,
  ): Promise<{ content: string; epoch: string; version: number }> {
    if (this.isLive(path)) return this.#opened(path);
    const opened = await this.#engine.open(path, async () => {
      const content = (await this.#fs.readFile(path)) ?? "";
      // The cap is UTF-8 bytes; chars lower-bound bytes, so only the gray
      // zone pays an encode.
      const bytes =
        content.length * 3 > MAX_DOC_BYTES
          ? new TextEncoder().encode(content).length
          : content.length;
      if (bytes > MAX_DOC_BYTES) {
        throw new Error(
          `file-too-large: ${path} is ${bytes} bytes; live collaboration caps at ${MAX_DOC_BYTES}`,
        );
      }
      return { content, epoch: crypto.randomUUID() };
    });
    // The seed awaited a repo/overlay read — a deleteFile in that window must
    // win: births racing a destruction are unwound, never resurrected.
    if ((this.#destroyed.get(path) ?? 0) !== destroyedBefore) {
      this.#engine.discard(path);
      this.#store.endSession(path);
      throw new Error(`${path} was deleted while the session was opening — retry to reopen`);
    }
    // Writes that landed while the seed was in flight took the NON-live path
    // (the session wasn't durable yet) — re-read now that it is, and fold any
    // divergence in as an external splice. Writes from here on route through
    // the live gateway, so one read closes the window; version 0 guards the
    // splice against a gateway write that beat the re-read. ANY failure in
    // this tail unwinds the birth — a session that survived its open's error
    // would serve the seed forever, hiding settled truth.
    try {
      const settled = await this.#fs.readFile(path);
      // The re-read awaited too: a destruction in ITS window must also unwind
      // (same rule as the seed), never hand back a session that already ended.
      if ((this.#destroyed.get(path) ?? 0) !== destroyedBefore || !this.isLive(path)) {
        this.#engine.discard(path);
        this.#store.endSession(path);
        throw new Error(`${path} was deleted while the session was opening — retry to reopen`);
      }
      if (settled && settled !== opened.content && this.#engine.head(path)?.version === 0) {
        await this.#engine.applyExternal(path, (doc) => minimalSplice(doc, settled));
      }
      // Return the LIVE head — a gateway write may have advanced the session
      // past the birth snapshot while this open was in flight.
      return this.#engine.head(path) ?? opened;
    } catch (error) {
      this.#engine.discard(path);
      this.#store.endSession(path);
      throw error;
    }
  }

  async push(raw: CollabPush): Promise<CollabPushResult> {
    const input = { ...raw, path: CollabHost.canonical(raw.path) };
    this.#touch(input.path);
    this.#assertLive(input.path);
    const head = await this.#opened(input.path);
    this.#assertQuota(input.path, head.version);
    return this.#engine.push(input);
  }

  /** Long-poll: resolves when ops land past afterVersion (or ~20s). */
  /** Head versions of every live session — the board's cheap change cursor. */
  versions(): Record<string, number> {
    // DURABLE heads, not memory: after an eviction the sessions are still
    // live and the board's cursor must see them before anyone re-opens.
    const map: Record<string, number> = {};
    for (const { headVersion, path } of this.#store.sessions()) {
      map[path] = this.#engine.head(path)?.version ?? headVersion;
    }
    return map;
  }

  async wait(
    rawPath: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabPull> {
    const path = CollabHost.canonical(rawPath);
    this.#assertLive(path);
    this.#lastActivity.set(path, Date.now()); // a parked watcher IS activity
    await this.#opened(path);
    // A client that tracks presence (afterPresence given) gets the current
    // map attached whenever its generation moved — piggybacked on ops
    // deliveries, or alone when only cursors moved.
    const withPresence = (pull: CollabPull): CollabPull => {
      if (pull.status !== "ops" || !Number.isFinite(afterPresence)) return pull;
      const generation = this.#presenceGeneration.get(path) ?? 0;
      return generation > afterPresence ? { ...pull, presence: this.#presenceFor(path) } : pull;
    };
    // Register BEFORE the first pull: an update landing between pull and
    // registration would otherwise be silently missed for a whole timeout.
    let finish!: () => void;
    const woke = new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(path) ?? new Set();
      this.#waiters.set(path, waiters);
      finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.#waiters.delete(path);
        resolve();
      };
      const timer = setTimeout(finish, WAIT_TIMEOUT_MS);
      waiters.add(finish);
    });
    const first = await this.#engine.pull(path, epoch, afterVersion, clientId);
    if (first.status !== "ops" || first.ops.length > 0) {
      finish(); // release OUR registration only — no spurious wake of peers
      return withPresence(first);
    }
    if (
      Number.isFinite(afterPresence) &&
      (this.#presenceGeneration.get(path) ?? 0) > afterPresence
    ) {
      finish(); // cursor news is already waiting — no park needed
      return withPresence(first);
    }
    await woke;
    if (!this.isLive(path)) return { status: "ended" };
    return withPresence(await this.#engine.pull(path, epoch, afterVersion, clientId));
  }

  /**
   * Announce (or clear, with null) one client's cursor. Quiet by design:
   * presence during teardown or after a destructive end is dropped, never an
   * error — cursors are decoration, not state.
   */
  present(
    rawPath: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): void {
    const path = CollabHost.canonical(rawPath);
    if (!this.isLive(path)) return;
    this.#lastActivity.set(path, Date.now());
    const clients = this.#presence.get(path) ?? new Map();
    this.#presence.set(path, clients);
    if (!selection) clients.delete(clientId);
    else clients.set(clientId, { anchor: selection.anchor, at: Date.now(), head: selection.head });
    this.#presenceGeneration.set(path, (this.#presenceGeneration.get(path) ?? 0) + 1);
    if (!this.#presenceWake.has(path)) {
      this.#presenceWake.set(
        path,
        setTimeout(() => {
          this.#presenceWake.delete(path);
          this.#wake(path);
        }, PRESENCE_WAKE_COALESCE_MS),
      );
    }
  }

  /** Fresh caret presence per live path — the board's "who has this open". */
  presenceSummary(): Record<string, string[]> {
    const now = Date.now();
    const summary: Record<string, string[]> = {};
    for (const [path, clients] of this.#presence) {
      const fresh = [...clients]
        .filter(([, cursor]) => now - cursor.at <= PRESENCE_STALE_MS)
        .map(([clientId]) => clientId)
        .sort();
      if (fresh.length > 0) summary[path] = fresh;
    }
    return summary;
  }

  #presenceFor(path: string): CollabPresence {
    const clients = this.#presence.get(path);
    const now = Date.now();
    if (clients) {
      for (const [clientId, cursor] of clients) {
        if (now - cursor.at > PRESENCE_STALE_MS) clients.delete(clientId);
      }
    }
    return {
      clients: [...(clients ?? new Map<string, { anchor: number; at: number; head: number }>())]
        .map(([clientId, cursor]) => ({
          anchor: cursor.anchor,
          at: cursor.at,
          clientId,
          head: cursor.head,
        }))
        .sort((left, right) => left.clientId.localeCompare(right.clientId)),
      generation: this.#presenceGeneration.get(path) ?? 0,
    };
  }

  // -- the live-file gateway (agent RPC routes through the session) ------------

  /** Live head for a durable session (recovering after eviction), else null. */
  async readFile(rawPath: string): Promise<string | null> {
    const path = CollabHost.canonical(rawPath);
    if (!this.isLive(path)) return null;
    return (await this.#opened(path)).content;
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    const content = await this.readFile(path);
    return !content ? null : new TextEncoder().encode(content);
  }

  /** Apply a whole-content write as a head-relative splice. False = not live. */
  async writeFile(rawPath: string, content: string, author?: string): Promise<boolean> {
    const path = CollabHost.canonical(rawPath);
    if (!this.isLive(path)) return false;
    const head = await this.#opened(path);
    this.#assertQuota(path, head.version);
    await this.#engine.applyExternal(path, (doc) => minimalSplice(doc, content), author);
    return true;
  }

  /** Canonical edit semantics against the live head. Null = not live. */
  async edit(raw: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult | null> {
    const input = { ...raw, path: CollabHost.canonical(raw.path) };
    if (!this.isLive(input.path)) return null;
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
    const head = await this.#opened(input.path);
    this.#assertQuota(input.path, head.version);
    let occurrenceCount = 0;
    await this.#engine.applyExternal(input.path, (doc) => {
      const content = doc.toString();
      occurrenceCount = countOccurrences(content, input.oldString);
      if (occurrenceCount === 0) {
        throw new Error(`Edit oldString was not found in "${input.path}".`);
      }
      if (!input.replaceAll && occurrenceCount !== 1) {
        throw new Error(
          `Edit oldString matched ${occurrenceCount} times in "${input.path}"; pass replaceAll to replace every occurrence.`,
        );
      }
      return minimalSplice(
        doc,
        replaceLiteralOccurrences({
          content,
          newString: input.newString,
          oldString: input.oldString,
        }),
      );
    });
    return { occurrenceCount, path: input.path };
  }

  // -- settlement and lifecycle ------------------------------------------------

  /**
   * THE barrier primitive: settle every durably-dirty session into the
   * overlay. Run before anything that classifies settled truth (status,
   * commit, configure) — it needs no in-memory state, so it is also the
   * crash-recovery path. Post-barrier keystrokes stay in the doc and
   * re-dirty on the next flush (same contract as a live barrier).
   *
   * Returns every live session's settled state as of this barrier — a commit
   * that follows contains exactly these; pass them to {@link markCommitted}
   * so redline baselines advance to what was actually committed, never
   * swallowing post-barrier keystrokes.
   */
  reconcile(): Promise<SettledFile[]> {
    return this.#exclusive(() => this.#settleAll());
  }

  async #settleAll(): Promise<SettledFile[]> {
    // WRITE only dirty sessions (flushing a clean one would pin its seed
    // over a mount HEAD that moved since), but REPORT every live session:
    // a commit that follows contains work the debounce already settled, and
    // its baseline must advance too or changes() keeps showing committed
    // text and the uncommitted-ops quota never resets. Clean sessions are
    // reported at their OVERLAY state (settled content + overlay version),
    // never the live head — a push racing this loop stays above the stamped
    // baseline and in the redline, exactly like a post-barrier keystroke.
    const settled: SettledFile[] = [];
    for (const session of this.#store.sessions()) {
      if (session.headVersion > session.overlayVersion) {
        const file = await this.#flush(session.path);
        if (file) settled.push(file);
        continue;
      }
      const head = await this.#opened(session.path);
      // Still clean at report time ⇒ the head IS the overlay state (a
      // never-flushed session has no overlay copy, and fs.readFile would
      // fall through to a possibly-moved mount HEAD — never stamp that).
      // If a racing push advanced the head mid-loop, the overlay copy the
      // earlier flushes wrote is the settled truth.
      const content =
        head.version === session.overlayVersion
          ? head.content
          : ((await this.#fs.readFile(session.path)) ?? head.content);
      settled.push({
        content,
        epoch: head.epoch,
        path: session.path,
        version: session.overlayVersion,
      });
    }
    return settled;
  }

  /**
   * THE commit fence: settle every session, run the commit, and stamp the
   * committed mount's baselines — as ONE coordinated job. No debounce flush,
   * open, configure, or destructive op can interleave, so the committed
   * overlay, the stamped baselines, and the barrier snapshot are one state.
   */
  async commitBarrier<T extends { mount?: string }>(
    runCommit: () => Promise<T>,
    ownsPath: (path: string, mount: string) => boolean,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const settled = await this.#settleAll();
      const result = await runCommit();
      if (result.mount) {
        const mount = result.mount;
        this.#store.setBases(settled.filter((file) => ownsPath(file.path, mount)));
      }
      return result;
    });
  }

  /** Settle-then-run under the coordinator (status/configure barriers). */
  barrier<T>(operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      await this.#settleAll();
      return operation();
    });
  }

  /**
   * Attributed tracked changes since the last commit (or session birth):
   * a pure fold of the retained op log over the stored baseline.
   */
  async changes(rawPath: string): Promise<CollabChangesResult> {
    const path = CollabHost.canonical(rawPath);
    this.#assertLive(path);
    const head = await this.#opened(path);
    const base = this.#store.getBase(path);
    if (!base) throw new Error(`no redline base recorded for ${path}`);
    const ops = await this.#store.readOps(path, head.epoch, base.version - 1);
    const segments = attributedChanges(Text.of(base.content.split("\n")), ops);
    // Two plain arrays on the wire (a union array breaks the generated
    // capnweb promise-mapped types); consumers re-interleave by position.
    return {
      // ONE baseline for both redline layers: the merge view diffs against
      // the same content the attribution folded from — never two sources
      // that can diverge under head motion or an interrupted commit.
      baseContent: base.content,
      baseVersion: base.version,
      deleted: segments.flatMap((segment) =>
        segment.kind === "deleted"
          ? [
              {
                at: segment.at,
                clientId: segment.clientId,
                createdAt: segment.createdAt,
                text: segment.text,
              },
            ]
          : [],
      ),
      headVersion: head.version,
      inserted: segments.flatMap((segment) =>
        segment.kind === "inserted"
          ? [
              {
                clientId: segment.clientId,
                createdAt: segment.createdAt,
                from: segment.from,
                to: segment.to,
              },
            ]
          : [],
      ),
    };
  }

  /** Durably end sessions (destructive ops: delete/byte-write/reset/revert).
   * Unflushed keystrokes are discarded BY DESIGN — flushing first would
   * defeat the destruction. Parked waiters wake into an epoch-less pull. */
  endSessions(paths?: string[]): void {
    // Synchronous ON PURPOSE (no coordinator await): destruction must win
    // instantly against anything mid-flight; the generation bump plus the
    // store's epoch-CAS unwind whatever was already queued.
    for (const path of (paths ?? this.livePaths()).map(CollabHost.canonical)) {
      this.#destroyed.set(path, (this.#destroyed.get(path) ?? 0) + 1);
      this.#lastActivity.delete(path);
      this.#presence.delete(path);
      this.#presenceGeneration.delete(path);
      const pendingWake = this.#presenceWake.get(path);
      if (pendingWake) clearTimeout(pendingWake);
      this.#presenceWake.delete(path);
      if (!this.isLive(path)) continue;
      this.#engine.discard(path);
      this.#store.endSession(path);
      this.#clearFlush(path);
      this.#wake(path);
    }
  }

  /** Opportunistic idle sweep: settle-and-end clean sessions nobody is
   * watching, so a later open seeds from fresh settled truth instead of
   * resurrecting a stale pin. Called from the DO's collab entry points. */
  #lastSweep = 0;

  async sweepIdle(now = Date.now()): Promise<void> {
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    await this.#exclusive(() => this.#sweep(now));
  }

  async #sweep(now: number): Promise<void> {
    for (const path of this.livePaths()) {
      const idleSince = this.#lastActivity.get(path);
      if (!Number.isFinite(idleSince)) {
        // A fresh incarnation has no activity memory: treat every durable
        // session as just-seen, or the first touch after a deploy would
        // "idle out" (and durably END) everyone else's live session.
        this.#lastActivity.set(path, now);
        continue;
      }
      if (now - idleSince < IDLE_END_MS) continue;
      if ((this.#waiters.get(path)?.size ?? 0) > 0) continue;
      await this.#flush(path).catch(() => {});
      if (this.#isDirty(path)) continue; // flush failed
      // The ONE end path: a wait that parked during the awaited flush must
      // wake into `ended` now, not sit out its whole timeout — and pending
      // flush timers die with the session.
      this.endSessions([path]);
    }
  }

  /**
   * Settle one session and return EXACTLY what was settled. The head is
   * captured ONCE — a push accepted mid-flush stays unflushed (and in the
   * redline) rather than being stamped as committed — and the destruction
   * generation is re-checked after every await so an in-flight flush can
   * never resurrect a path a destructive op just ended.
   */
  async #flush(path: string): Promise<SettledFile | null> {
    this.#clearFlush(path);
    const generation = this.#destroyed.get(path) ?? 0;
    if (!this.isLive(path)) return null;
    // Same dirtiness guard for the debounce lane: only unflushed work may
    // touch the overlay (see #settleAll on why a clean write is harmful).
    if (!this.#isDirty(path)) return null;
    const head = await this.#opened(path);
    const settled = await this.#fs.readFile(path);
    if ((this.#destroyed.get(path) ?? 0) !== generation || !this.isLive(path)) return null;
    if (settled !== head.content) await this.#fs.writeFile(path, head.content);
    this.#store.markFlushed(path, head.version, head.epoch);
    return { content: head.content, epoch: head.epoch, path, version: head.version };
  }

  #scheduleFlush(path: string): void {
    const now = Date.now();
    const existing = this.#flushTimers.get(path);
    const max = existing?.max ?? now + FLUSH_MAX_MS;
    if (existing) clearTimeout(existing.timer);
    const delay = Math.max(0, Math.min(now + FLUSH_IDLE_MS, max) - now);
    this.#flushTimers.set(path, {
      max,
      // A lost or failed timer costs only latency: the durable dirty marker
      // survives and the next barrier settles it. Coordinated, so a timer
      // can never land inside a commit fence.
      timer: setTimeout(() => void this.#exclusive(() => this.#flush(path)).catch(() => {}), delay),
    });
  }

  #clearFlush(path: string): void {
    const pending = this.#flushTimers.get(path);
    if (pending) clearTimeout(pending.timer);
    this.#flushTimers.delete(path);
  }

  #wake(path: string): void {
    for (const finish of [...(this.#waiters.get(path) ?? [])]) finish();
  }

  #touch(path: string): void {
    this.#lastActivity.set(path, Date.now());
    void this.sweepIdle().catch(() => {});
  }

  #isDirty(path: string): boolean {
    const session = this.#store.sessions().find((candidate) => candidate.path === path);
    return !!session && session.headVersion > session.overlayVersion;
  }

  #assertLive(path: string): void {
    if (!this.isLive(path)) throw new Error(`no live session for ${path} — open first`);
  }

  /** "Bounded by commit cadence" needs an actual bound on EVERY acceptance
   * lane (browser pushes AND the agent gateway): past the quota the session
   * refuses new ops until a commit advances the baseline (which prunes).
   * Typed and loud — never silent unbounded growth. */
  #assertQuota(path: string, headVersion: number): void {
    const base = this.#store.getBase(path);
    if (base && headVersion - base.version >= MAX_UNCOMMITTED_OPS) {
      throw new Error(
        `retention quota: ${path} has ${headVersion - base.version} uncommitted ops — commit to continue`,
      );
    }
  }
}
