import { Text } from "@codemirror/state";
import { countOccurrences, replaceLiteralOccurrences } from "../repos/edit-utils.ts";
import { attributedChanges, type CollabChangeSegment } from "./collab-changes.ts";
import type { EditWorkspaceFileInput, EditWorkspaceFileResult } from "./types.ts";
import {
  CollabEngine,
  MAX_DOC_BYTES,
  minimalSplice,
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
  /** Paths whose accepted head is ahead of the settled overlay. */
  dirtySessions(): string[];
  /** Every durable session path (the routing truth across incarnations). */
  livePaths(): string[];
  /** Whether a durable session exists — one local-SQLite lookup. */
  hasSession(path: string): boolean;
  /** Record that `version` is settled into the overlay. */
  markFlushed(path: string, version: number): void;
  /** The redline baseline: seed content at birth, re-stamped at each commit.
   * Retention keeps ops back to this version, so tracked changes are always
   * reconstructable — the op log IS the redline data. */
  getBase(path: string): { content: string; version: number } | null;
  setBase(path: string, base: { content: string; version: number }): void;
  /** Delete the session, its snapshot, its ops, and its base — the durable end. */
  endSession(path: string): void;
}

/** One settled file from a reconcile barrier — exactly what a commit that
 * follows the barrier will contain for that path. */
export interface SettledFile {
  content: string;
  path: string;
  version: number;
}

const FLUSH_IDLE_MS = 2_000;
const FLUSH_MAX_MS = 15_000;
const WAIT_TIMEOUT_MS = 20_000;
const IDLE_END_MS = 5 * 60_000;

export class CollabHost {
  readonly #fs: CollabSettledFs;
  readonly #store: CollabSessionStore;
  readonly #engine: CollabEngine;
  /** Bumped per durable end; open() re-checks it after its awaited seed so a
   * concurrent delete can never be resurrected by a slow-seeding open. */
  readonly #destroyed = new Map<string, number>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #flushTimers = new Map<string, { max: number; timer: ReturnType<typeof setTimeout> }>();
  readonly #lastActivity = new Map<string, number>();

  constructor(options: { fs: CollabSettledFs; store: CollabSessionStore }) {
    this.#fs = options.fs;
    this.#store = options.store;
    this.#engine = new CollabEngine({
      broadcast: (event) => {
        this.#wake(event.path);
        this.#scheduleFlush(event.path);
      },
      store: options.store,
    });
  }

  /** Session keys are canonical absolute paths — `tasks/x.md` and
   * `/tasks/x.md` must address ONE authority over one file. */
  static canonical(path: string): string {
    return path.startsWith("/") ? path : `/${path}`;
  }

  /** Liveness IS the durable session table — no in-memory mirror to drift. */
  isLive(path: string): boolean {
    return this.#store.hasSession(CollabHost.canonical(path));
  }

  /** The engine for a durable session, recovered lazily after eviction. */
  async #opened(path: string) {
    return this.#engine.open(path, () => {
      throw new Error(`session for ${path} is durable but has no snapshot — store corruption`);
    });
  }

  // -- session lane ------------------------------------------------------------

  async open(rawPath: string): Promise<{ content: string; epoch: string; version: number }> {
    const path = CollabHost.canonical(rawPath);
    this.#touch(path);
    if (this.isLive(path)) return this.#opened(path);
    const destroyedBefore = this.#destroyed.get(path) ?? 0;
    const opened = await this.#engine.open(path, async () => {
      const content = (await this.#fs.readFile(path)) ?? "";
      if (content.length > MAX_DOC_BYTES) {
        throw new Error(
          `file-too-large: ${path} is ${content.length} bytes; live collaboration caps at ${MAX_DOC_BYTES}`,
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
    return opened;
  }

  async push(raw: CollabPush): Promise<CollabPushResult> {
    const input = { ...raw, path: CollabHost.canonical(raw.path) };
    this.#touch(input.path);
    this.#assertLive(input.path);
    await this.#opened(input.path);
    return this.#engine.push(input);
  }

  /** Long-poll: resolves when ops land past afterVersion (or ~20s). */
  async wait(rawPath: string, epoch: string, afterVersion: number): Promise<CollabPull> {
    const path = CollabHost.canonical(rawPath);
    this.#assertLive(path);
    await this.#opened(path);
    const first = await this.#engine.pull(path, epoch, afterVersion);
    if (first.status !== "ops" || first.ops.length > 0) return first;
    await new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(path) ?? new Set();
      this.#waiters.set(path, waiters);
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, WAIT_TIMEOUT_MS);
      waiters.add(finish);
    });
    if (!this.isLive(path)) return { status: "ended" };
    return this.#engine.pull(path, epoch, afterVersion);
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
    return content === null ? null : new TextEncoder().encode(content);
  }

  /** Apply a whole-content write as a head-relative splice. False = not live. */
  async writeFile(rawPath: string, content: string, author?: string): Promise<boolean> {
    const path = CollabHost.canonical(rawPath);
    if (!this.isLive(path)) return false;
    await this.#opened(path);
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
    await this.#opened(input.path);
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
  async reconcile(): Promise<SettledFile[]> {
    const settled: SettledFile[] = [];
    for (const path of this.#store.livePaths()) {
      const file = await this.#flush(path);
      if (file !== null) settled.push(file);
    }
    return settled;
  }

  /** Advance redline baselines to a just-committed barrier snapshot. */
  markCommitted(settled: SettledFile[]): void {
    for (const file of settled) {
      if (!this.isLive(file.path)) continue;
      this.#store.setBase(file.path, { content: file.content, version: file.version });
    }
  }

  /**
   * Attributed tracked changes since the last commit (or session birth):
   * a pure fold of the retained op log over the stored baseline.
   */
  async changes(rawPath: string): Promise<{
    baseVersion: number;
    headVersion: number;
    segments: CollabChangeSegment[];
  }> {
    const path = CollabHost.canonical(rawPath);
    this.#assertLive(path);
    const head = await this.#opened(path);
    const base = this.#store.getBase(path);
    if (base === null) throw new Error(`no redline base recorded for ${path}`);
    const ops = await this.#store.readOps(path, head.epoch, base.version - 1);
    return {
      baseVersion: base.version,
      headVersion: head.version,
      segments: attributedChanges(Text.of(base.content.split("\n")), ops),
    };
  }

  /** Durably end sessions (destructive ops: delete/byte-write/reset/revert).
   * Unflushed keystrokes are discarded BY DESIGN — flushing first would
   * defeat the destruction. Parked waiters wake into an epoch-less pull. */
  endSessions(paths?: string[]): void {
    for (const path of (paths ?? this.#store.livePaths()).map(CollabHost.canonical)) {
      this.#destroyed.set(path, (this.#destroyed.get(path) ?? 0) + 1);
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
  async sweepIdle(now = Date.now()): Promise<void> {
    for (const path of this.#store.livePaths()) {
      const idleSince = this.#lastActivity.get(path);
      if (idleSince === undefined) {
        // A fresh incarnation has no activity memory: treat every durable
        // session as just-seen, or the first touch after a deploy would
        // "idle out" (and durably END) everyone else's live session.
        this.#lastActivity.set(path, now);
        continue;
      }
      if (now - idleSince < IDLE_END_MS) continue;
      if ((this.#waiters.get(path)?.size ?? 0) > 0) continue;
      await this.#flush(path).catch(() => {});
      if (this.#store.dirtySessions().includes(path)) continue; // flush failed
      this.#destroyed.set(path, (this.#destroyed.get(path) ?? 0) + 1);
      this.#engine.discard(path);
      this.#store.endSession(path);
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
    const head = await this.#opened(path);
    const settled = await this.#fs.readFile(path);
    if ((this.#destroyed.get(path) ?? 0) !== generation || !this.isLive(path)) return null;
    if (settled !== head.content) await this.#fs.writeFile(path, head.content);
    this.#store.markFlushed(path, head.version);
    return { content: head.content, path, version: head.version };
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
      // survives and the next barrier settles it.
      timer: setTimeout(() => void this.#flush(path).catch(() => {}), delay),
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

  #assertLive(path: string): void {
    if (!this.isLive(path)) throw new Error(`no live session for ${path} — open first`);
  }
}
