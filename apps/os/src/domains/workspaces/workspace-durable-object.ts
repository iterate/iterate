import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import type { StreamEventInput } from "iterate/processors";
import { isStreamOffsetConflictError } from "iterate/processors";
import { minimatch } from "minimatch";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  projectProcessorState,
  STREAM_DURABLE_OBJECT_STUB,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { isUnconfiguredSubscriptionError } from "../streams/utils.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceCommitInput,
  WorkspaceCommitResult,
  WorkspaceEffectiveConfig,
  WorkspaceGitLogEntry,
  WorkspaceGitLogInput,
  WorkspaceStatus,
} from "./types.ts";
import {
  WorkspaceProcessorContract,
  type WorkspaceConfig,
  type WorkspaceConfigPatch,
  type WorkspaceMount,
  type WorkspaceProcessorState,
} from "./workspace-processor-contract.ts";
import { mergeWorkspaceConfigPatch } from "./workspace-processor-implementation.ts";
import {
  isVirtualDirectoryPath,
  reRoutedPaths,
  routeMount,
  WorkspaceCore,
  type MountRepoAccess,
} from "./workspace-core.ts";
import { effectiveWorkspaceMounts, normalizeWorkspaceMountKeys } from "./utils.ts";
import { resolveAbsolutePath } from "./paths.ts";
import type { CollabPull, CollabPush, CollabPushResult } from "./collab-engine.ts";
import { CollabHost, type CollabPresenceFlat } from "./collab-host.ts";
import { sqliteCollabStore } from "./collab-store.ts";

const PROCESSOR_SLUG = WorkspaceProcessorContract.slug;

/** The stream facade methods this DO reads its own fold through — the
 * workspace processor runs as a facet of the workspace stream's own Durable
 * Object (src/domains/processor-facet-durable-object.ts), not here. */
type WorkspaceProcessorFacade = {
  snapshot(): Promise<{ offset: number; state: WorkspaceProcessorState }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void>;
};
// Configuration appends assert their exact stream offset (no interleaved
// append can invalidate the validated plan); a conflict re-plans against the
// fresh state. Bounded: past this, something is genuinely storming the stream.
const MAX_CONFIGURE_ATTEMPTS = 5;
// The workspace reduce is pure and normally completes during catchUp; if
// ingestion is broken, fail the command instead of retaining its RPC forever.
const INGEST_WAIT_TIMEOUT_MS = 15_000;

/**
 * One workspace: an EVENT-SOURCED, MOUNT-ROUTED durable workspace.
 *
 * Identity and configuration are stream facts — `workspace/created` is the
 * birth certificate (carrying the initial config), `workspace/configured`
 * patches it — reduced by {@link WorkspaceProcessor} under the ordinary
 * registry/runner machinery. The mount table in that reduced config routes
 * everything else: reads fall through per subtree to the longest-prefix
 * mount's repo at HEAD, writes land in this DO's private local layer
 * (DO-SQLite via `@cloudflare/shell`, R2 spill past ~1.5MB), and
 * `gitCommit({ scope })` turns one mount's changes into one commit on THAT
 * repo's main via its own `commitFiles` lane.
 *
 * A workspace must be explicitly created before any filesystem or
 * configuration method can use it. Addressing the Durable Object never births
 * it; a missing birth certificate is a loud command error.
 *
 * The filesystem/overlay semantics live in {@link WorkspaceCore}; this DO is
 * the thin host wiring storage, the processor's reduced state, and repo stubs
 * together.
 *
 * The class is deliberately NOT named `WorkspaceDurableObject`: declarative
 * Durable Object exports key namespaces by class name, and the retired
 * single-parent-overlay workspace occupied that name — reusing it would
 * inherit the old namespace's storage. Its uncommitted overlays were
 * disposable by contract (committed state lives on main), so that namespace
 * is simply dropped.
 */
export class WorkspaceV2DurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  /** In-memory mirror of the facet-hosted processor's reduced config: every
   * public op's #assertCreated() refreshes it through the stream facade, so
   * the synchronous reads below (`#currentConfig`, the WorkspaceCore mounts
   * thunk) serve exactly what the retired in-DO runner served. */
  #reducedState: WorkspaceProcessorState | undefined;

  readonly #workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.name,
    // Files past @cloudflare/shell's inline threshold (1.5MB — the DO SQLite
    // row cap zone) spill transparently to R2. Own prefix: the retired
    // overlay-workspace namespace used "workspace/" and could mint the SAME
    // name string for the same path; their bucket objects must never collide.
    r2: this.env.FILES_BUCKET,
    r2Prefix: `workspace-v2/${this.ctx.id.name!}`,
  });
  readonly #core = new WorkspaceCore({
    kv: this.ctx.storage.kv,
    // Fresh per operation: every public op below runs #assertCreated() first,
    // so this thunk reads already-fresh reduced overlays (the repo list rides
    // the per-incarnation cache, refreshed by the doors — see #repoPaths).
    mounts: () => this.#effectiveMounts(),
    repo: (repoPath) => this.#repoStub(repoPath),
    scratchRoot: this.#name.path,
    workspace: this.#workspace,
  });

  #repoStub(repoPath: string): MountRepoAccess {
    return this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({ path: repoPath, projectId: this.#name.projectId }),
    );
  }

  /** The facet-hosted workspace processor's read surface on the stream. */
  async #processorFacade(): Promise<WorkspaceProcessorFacade> {
    return (await this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        path: this.#name.path,
        projectId: this.#name.projectId,
      }),
    ).processorFacade({
      name: PROCESSOR_SLUG,
      // The Stream DO's facade forwards to the facet registered for this
      // path family; /workspaces/** registers exactly the workspace
      // processor under this name, so its snapshot/waitUntilProcessed doors
      // carry WorkspaceProcessorState. Double assertion because the
      // generated stub type erases the per-name state parameter.
    })) as unknown as WorkspaceProcessorFacade;
  }

  /** Refresh the local mirror from the facade (a catch-up-backed snapshot). */
  async #refreshReducedState(): Promise<WorkspaceProcessorState> {
    let state: WorkspaceProcessorState;
    try {
      ({ state } = await (await this.#processorFacade()).snapshot());
    } catch (error) {
      // Before the birth batch commits, the workspace subscription is absent
      // from the stream catalog (and a read must never materialize its facet).
      // The contract's initial fold lets #assertCreated report the domain's
      // friendly missing-workspace guidance while every other error remains
      // loud.
      if (!isUnconfiguredSubscriptionError(error)) throw error;
      state = WorkspaceProcessorContract.stateSchema.parse({});
    }
    this.#reducedState = state;
    return state;
  }

  /** The stored OVERLAY table (reduced state) — deviations only. Synchronous
   * against the mirror; every public op refreshes it first (#assertCreated). */
  #currentConfig(): WorkspaceConfig {
    const state = this.#reducedState;
    if (state === undefined) {
      throw new Error("workspace reduced state read before its operation refreshed it");
    }
    return state.config;
  }

  /**
   * The project's repo paths, from the project stream's reduced state —
   * cached per incarnation. The cache refreshes on demand: enumerating and
   * git operations refresh at entry, and per-path operations refresh exactly
   * when a `/repos/**` path fails to route (#freshenRouting) — so "create a
   * repo, then read it" is fresh by construction without a fan-out
   * subscription lane, while overlay-hit reads never pay the project RPC.
   */
  #repoPathsCache: string[] | null = null;
  // Single-flight: concurrent refreshes share one project read, so two
  // out-of-order responses can never regress the cache to an older list.
  #repoPathsRefresh: Promise<string[]> | null = null;

  async #repoPaths(options: { refresh?: boolean } = {}): Promise<string[]> {
    if (this.#repoPathsCache !== null && options.refresh !== true) return this.#repoPathsCache;
    this.#repoPathsRefresh ??= (async () => {
      try {
        const projectId = this.#name.projectId;
        const paths =
          projectId === null
            ? []
            : (await projectProcessorState(projectId)).repos.map((repo) => repo.path);
        this.#repoPathsCache = paths;
        return paths;
      } finally {
        this.#repoPathsRefresh = null;
      }
    })();
    return this.#repoPathsRefresh;
  }

  /** The EFFECTIVE mount table: every project repo at its own /repos/** path,
   * with the stored overlays merged on top. */
  async #effectiveMounts(
    options: { refresh?: boolean } = {},
  ): Promise<Record<string, WorkspaceMount>> {
    return effectiveWorkspaceMounts(await this.#repoPaths(options), this.#currentConfig().mounts);
  }

  /**
   * Refresh the repo list exactly when a `/repos/**` path fails to route —
   * the "repo created moments ago" case. Routing hits and non-repo paths
   * never pay the project read.
   */
  async #freshenRouting(paths: string[]): Promise<void> {
    const mounts = await this.#effectiveMounts();
    const missed = paths.some((path) => {
      const resolved = resolveAbsolutePath(path);
      return (
        resolved.startsWith("/repos/") &&
        routeMount(mounts, resolved) === null &&
        !isVirtualDirectoryPath(mounts, resolved)
      );
    });
    if (missed) await this.#effectiveMounts({ refresh: true });
  }

  /**
   * Workspace paths are absolute within the project's one namespace; a
   * RELATIVE path resolves against this workspace's own directory (its
   * stream path) — `readFile("notes.md")` is
   * `readFile("/workspaces/agents/you/notes.md")`.
   */
  #resolvePath(path: string): string {
    return resolveAbsolutePath(path.startsWith("/") ? path : `${this.#name.path}/${path}`);
  }

  /** Pull the reduced state current and require an explicit birth certificate.
   * STRICT catch-up (throws): every public operation routes and
   * classifies against the reduced config, and a swallowed catch-up failure
   * would let it proceed on a stale mount table — misrouting reads and commits
   * — when a committed `configured` event exists but has not reduced. Failing
   * the operation loudly is the only safe disposition. The facade's snapshot
   * IS the strict catch-up, and refreshing the mirror here is what keeps the
   * synchronous `#currentConfig` reads fresh per operation. */
  async #assertCreated(): Promise<void> {
    const state = await this.#refreshReducedState();
    if (state.birthCertificate !== null) return;
    throw new Error(
      `workspace "${this.#name.path}" does not exist — create it with itx.workspaces.get(${JSON.stringify(this.#name.path)}).create({})`,
    );
  }

  /**
   * The ONE validated configuration transition: plan against the freshest
   * reduced state, append with an exact-offset assertion (an interleaved raw
   * append conflicts instead of silently invalidating the plan), re-plan on
   * conflict, and return only after the reduced state provably includes the
   * change. Runs inside the core's serialized chain via its callers.
   */
  async #applyConfigTransition(
    repoPaths: string[],
    plan: (current: WorkspaceConfig) => WorkspaceConfigPatch | null,
  ): Promise<WorkspaceConfig> {
    for (let attempt = 1; attempt <= MAX_CONFIGURE_ATTEMPTS; attempt++) {
      // Pin BOTH heads in one read: the reduction barrier waits for the
      // DURABLE head — a durable processor catch-up never sees ephemeral events, so
      // waiting for the raw head would wedge on a trailing ephemeral suffix —
      // while the CAS below asserts against the RAW head, where offsets are
      // actually assigned. waitUntilEvent THROWS on a wedged catch-up, so a
      // stale runner can never validate a plan or report convergence
      // silently; the exact-offset append turns any raw/durable skew into a
      // plain conflict retry.
      const { maxDurableOffset, maxOffset: rawHead } =
        await this.#stream[STREAM_DURABLE_OBJECT_STUB].getMaxOffsets();
      await (
        await this.#processorFacade()
      ).waitUntilProcessed({
        offset: maxDurableOffset,
        timeoutMs: INGEST_WAIT_TIMEOUT_MS,
      });
      await this.#refreshReducedState();
      const current = this.#currentConfig();
      const patch = plan(current);
      if (patch === null) return current;
      const next = mergeWorkspaceConfigPatch(current, patch);
      // Ownership/collision safety, judged inside the lock against the exact
      // EFFECTIVE tables this append will transition between (same derived
      // default on both sides — only the overlays move).
      await this.#core.assertMountTransitionSafe(
        effectiveWorkspaceMounts(repoPaths, current.mounts),
        effectiveWorkspaceMounts(repoPaths, next.mounts),
      );
      try {
        const [event] = await this.#stream.append({
          ...WorkspaceProcessorContract.buildEvent({
            type: "events.iterate.com/workspace/configured",
            payload: { config: patch },
          }),
          offset: rawHead + 1,
        } as StreamEventInput);
        await (
          await this.#processorFacade()
        ).waitUntilProcessed({
          offset: event!.offset,
          timeoutMs: INGEST_WAIT_TIMEOUT_MS,
        });
        await this.#refreshReducedState();
        return this.#currentConfig();
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_CONFIGURE_ATTEMPTS) throw error;
      }
    }
    throw new Error("unreachable configuration transition retry state");
  }

  whoami(): string {
    return `workspace ${this.#name.projectId}:${this.#name.path} (event-sourced, mount-routed)`;
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  // -- lifecycle / configuration ----------------------------------------------

  /** The live configuration: the EFFECTIVE mount table (derived default
   * merged with the stored overlay patches). */
  async getConfig(): Promise<WorkspaceEffectiveConfig> {
    await this.#assertCreated();
    return { mounts: await this.#effectiveMounts({ refresh: true }) };
  }

  /**
   * Append a `workspace/configured` overlay patch and return the resulting
   * EFFECTIVE config (read-your-writes: the command only returns once the
   * reduced state provably includes the event it appended). The patch
   * deep-merges per mount point: unknown keys add overlays, partial values
   * edit existing ones, `null` clears one (the derived default returns). The
   * MERGED result is validated against the effective table here before the
   * append, so a patch that would leave a broken table fails loudly at the
   * door.
   */
  async configure(input: { config: WorkspaceConfigPatch }): Promise<WorkspaceEffectiveConfig> {
    await this.#assertCreated();
    const config: WorkspaceConfigPatch =
      input.config.mounts === undefined
        ? input.config
        : { ...input.config, mounts: normalizeWorkspaceMountKeys(input.config.mounts) };
    // Under the collab BARRIER (settle + run as ONE coordinated job): live
    // sessions settle so their dirtiness is visible to the transition-safety
    // check, and no debounce flush can interleave between that settle and the
    // transition itself — the same fence commits use.
    return this.#collab.barrier(async () => {
      // ONE repo-list snapshot for the whole transition, taken fresh: the
      // before/after tables, the completeness validation, and the collab
      // re-route diff must all speak the same derived default.
      const repoPaths = await this.#repoPaths({ refresh: true });
      const before = effectiveWorkspaceMounts(repoPaths, this.#currentConfig().mounts);
      // Serialized with the core's mutations and commits: an unmount or repo
      // swap must never interleave a commit that already classified against
      // the old table.
      const appliedOverlays = await this.#core.runExclusive(() =>
        this.#applyConfigTransition(repoPaths, (current) => {
          // The reduce is deliberately TOLERANT (a committed event must never
          // wedge the reducer), so the door supplies the loudness — validated
          // against the exact state this append will land on (the offset
          // assertion makes an interleaved append a retry, not a silent drop):
          // every non-null patch entry must survive into a complete EFFECTIVE
          // mount (a partial overlay completes against a derived mount; at a
          // non-derived path it completes nothing).
          const merged = mergeWorkspaceConfigPatch(current, config);
          const effective = effectiveWorkspaceMounts(repoPaths, merged.mounts);
          for (const [key, value] of Object.entries(config.mounts ?? {})) {
            if (value === null) continue;
            if (!(key in effective)) {
              throw new Error(
                `mount "${key}" patch does not produce a complete mount — new mounts need { repoPath, policy }`,
              );
            }
            // A ghost repoPath would route (writes accepted!) but every
            // enumeration (listAllFiles/glob/status) then dies on the
            // unseeded repo stub — one typo must not break the workspace.
            if (value.repoPath !== undefined && !repoPaths.includes(value.repoPath)) {
              throw new Error(
                `mount "${key}" names "${value.repoPath}", which is not a repo in this project — create it first (itx.repos.get(path).create(...))`,
              );
            }
          }
          return config;
        }),
      );
      const applied = effectiveWorkspaceMounts(repoPaths, appliedOverlays.mounts);
      // A session whose OWNING mount changed — removed, re-pointed, or the
      // path stolen by a newly added nested mount — would keep serving the
      // old repo's text as the live truth (and flush it into the NEW mount's
      // repo). Ownership is routeMount's longest-prefix rule, diffed across
      // the transition; the barrier settled dirty work, so nothing is lost.
      const live = this.#collab.livePaths();
      const doomed = new Set(reRoutedPaths(before, applied, live));
      // A path that BECAME a virtual directory (a nested mount landed at or
      // below it) keeps its owner but can't stay a live file — reads would
      // serve a file at a directory path and its flush would die in the
      // mount-point write guard, wedging every settle barrier.
      const becameDirectories: string[] = [];
      for (const path of live) {
        if (isVirtualDirectoryPath(applied, path)) {
          doomed.add(path);
          becameDirectories.push(path);
        }
      }
      if (doomed.size > 0) this.#collab.endSessions([...doomed]);
      // The barrier's settle may have flushed an overlay FILE at a path the
      // new table makes a DIRECTORY — a ghost that would shadow the mounted
      // subtree (overlay copies win over the virtual-dir mask). Drop it; the
      // mount transition is the destructive act here, same posture as
      // endSessions discarding unflushed keystrokes.
      for (const path of becameDirectories) {
        await this.#core.revert(path).catch(() => {});
      }
      return { mounts: applied };
    });
  }

  // A live collaborative session is the current truth for its path, and the
  // durable session table (not this incarnation's memory) decides liveness —
  // so every fs method routes through the host's gateway first, and every
  // settled-truth classifier runs the host's reconcile barrier first. See
  // collab-host.ts for the invariants.
  readonly #collab = new CollabHost({
    fs: this.#core,
    // The live pulse: every accepted batch appends an EPHEMERAL stream event
    // (delivered to live subscribers, never replayed — the llm-chunk lane's
    // idiom), so the workspace's event sheet breathes while people type.
    onBroadcast: (event) => {
      void this.#stream
        .append({
          ephemeral: true,
          payload: {
            clients: [...new Set(event.ops.map((op) => op.clientId))],
            path: event.path,
            toVersion: event.toVersion,
          },
          type: "events.iterate.com/workspace/live-edit",
        } as StreamEventInput)
        .catch(() => {});
    },
    store: sqliteCollabStore(this.ctx.storage),
  });

  // -- filesystem ----------------------------------------------------------------

  async readFile(path: string): Promise<string | null> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    return (await this.#collab.readFile(resolved)) ?? this.#core.readFile(resolved);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    return (await this.#collab.readFileBytes(resolved)) ?? this.#core.readFileBytes(resolved);
  }

  /**
   * Batched reads for board-style consumers: ONE RPC for the whole file set
   * instead of a call per file through a client chain. Live sessions route
   * exactly like readFile; missing paths map to null. Bounded loudly.
   */
  async readFiles(paths: string[]): Promise<Record<string, string | null>> {
    await this.#assertCreated();
    if (paths.length > 10_000) throw new Error("readFiles caps at 10000 paths per call");
    await this.#freshenRouting(paths.map((path) => this.#resolvePath(path)));
    const result: Record<string, string | null> = {};
    // Live sessions and overlay copies first (local, concurrent); the mount
    // fall-through is grouped so each mount pays ONE snapshot RPC — fanning
    // per-file reads at a repo object is the documented overload. Results are
    // keyed by the CALLER's spelling (relative paths stay relative).
    const leftover: { path: string; resolved: string }[] = [];
    await Promise.all(
      paths.map(async (path) => {
        const resolved = this.#resolvePath(path);
        const live = await this.#collab.readFile(resolved);
        if (live !== null) {
          result[path] = live;
          return;
        }
        const local = await this.#core.readOverlayFile(resolved);
        if (local !== null) {
          result[path] = local;
          return;
        }
        leftover.push({ path, resolved });
      }),
    );
    // The core groups the fall-through per mount and asks each repo for
    // exactly the routed paths — the mount table is read THERE, after the
    // local awaits, so a configure landing during them routes exactly as a
    // fresh per-file readFile would.
    const fallThrough = await this.#core.readMountFiles(leftover.map((entry) => entry.resolved));
    for (const entry of leftover) result[entry.path] = fallThrough[entry.resolved] ?? null;
    return result;
  }

  /** A path's mount content at HEAD — what uncommitted work diffs against. */
  async readBase(path: string): Promise<string | null> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    return this.#core.readBase(resolved);
  }

  async exists(path: string): Promise<boolean> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    // A live session IS existence: a collab-created file can be readable
    // before its first flush lands in the overlay.
    return this.#collab.isLive(resolved) || this.#core.exists(resolved);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    if (await this.#collab.writeFile(resolved, content)) return;
    return this.#core.writeFile(resolved, content);
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    // A binary replace ends any text session (unflushed edits discarded by
    // design — same posture as delete/reset).
    this.#collab.endSessions([resolved]);
    return this.#core.writeFileBytes(resolved, data);
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    await this.#assertCreated();
    const resolved = { ...input, path: this.#resolvePath(input.path) };
    await this.#freshenRouting([resolved.path]);
    return (await this.#collab.edit(resolved)) ?? this.#core.edit(resolved);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    // End the session BEFORE the whiteout lands, so no flush can resurrect.
    this.#collab.endSessions([resolved]);
    return this.#core.deleteFile(resolved);
  }

  async listAllFiles(): Promise<string[]> {
    await this.#assertCreated();
    // Enumerations must see freshly created repos — refresh the derived
    // table up front (these are heavy, rare operations anyway).
    await this.#effectiveMounts({ refresh: true });
    // Live-only sessions (opened on a missing path, unflushed) are readable
    // and exist — listings must agree with readFile/exists.
    const merged = new Set(await this.#core.listAllFiles());
    for (const path of this.#collab.livePaths()) merged.add(path);
    return [...merged].sort();
  }

  async glob(pattern: string): Promise<string[]> {
    // listAllFiles runs the birth assertion (same error, no duplicate round).
    // A relative pattern globs this workspace's own directory; `.`/`..`
    // segments collapse exactly like the file doors' paths do (glob magic
    // like `**` and `*.md` never contains a slash, so it survives the
    // resolve untouched).
    const resolved = resolveAbsolutePath(
      pattern.startsWith("/") ? pattern : `${this.#name.path}/${pattern}`,
    );
    const all = await this.listAllFiles();
    return all.filter((path) => minimatch(path, resolved, { dot: true }));
  }

  async reset(): Promise<void> {
    await this.#assertCreated();
    this.#collab.endSessions();
    return this.#core.reset();
  }

  async revert(path: string): Promise<void> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    this.#collab.endSessions([resolved]);
    return this.#core.revert(resolved);
  }

  // -- collaborative sessions (see collab-host.ts / collab-engine.ts) --------------

  async collabOpen(path: string): Promise<{ content: string; epoch: string; version: number }> {
    await this.#assertCreated();
    const resolved = this.#resolvePath(path);
    await this.#freshenRouting([resolved]);
    // A live session's flush is a WRITE — pre-check the whole write guard
    // (mount points and virtual ancestors are directories; unmounted paths
    // outside the workspace's own directory are not writable), so a doomed
    // flush can never wedge every workspace-wide settle barrier.
    await this.#core.assertWritable(resolved);
    // A whiteouted path is DELETED: an empty-seed birth would make it exist
    // again (and its first flush would clear the whiteout, undoing the
    // delete). Recreation is an explicit write, never an open.
    if (
      this.#core.isMaskedFromMount(resolved) &&
      (await this.#core.readOverlayFile(resolved)) === null
    ) {
      throw new Error(`"${resolved}" was deleted — write it to recreate before opening a session`);
    }
    const opened = await this.#collab.open(resolved);
    void this.#stream
      .append({
        ephemeral: true,
        payload: { epoch: opened.epoch, path: resolved, version: opened.version },
        type: "events.iterate.com/workspace/session-opened",
      } as StreamEventInput)
      .catch(() => {});
    return opened;
  }

  async collabPush(input: CollabPush): Promise<CollabPushResult> {
    await this.#assertCreated();
    return this.#collab.push({ ...input, path: this.#resolvePath(input.path) });
  }

  /** Long-poll lane: resolves when ops land past afterVersion (or ~20s);
   * with afterPresence given, also when cursors moved past that generation. */
  async collabWait(
    path: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabPull> {
    await this.#assertCreated();
    return this.#collab.wait(this.#resolvePath(path), epoch, afterVersion, clientId, afterPresence);
  }

  /** Announce (or clear, with null) one client's cursor — quiet decoration,
   * fanned out to session waiters coalesced. */
  async collabPresent(
    path: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): Promise<void> {
    await this.#assertCreated();
    this.#collab.present(this.#resolvePath(path), clientId, selection);
  }

  /** Head versions of every live session (the board's change cursor). */
  async collabVersions(): Promise<Record<string, number>> {
    await this.#assertCreated();
    return this.#collab.versions();
  }

  /** Attributed tracked changes since the last commit (redline segments). */
  async collabChanges(path: string) {
    await this.#assertCreated();
    return this.#collab.changes(this.#resolvePath(path));
  }

  // Board-level viewer presence: who has the BOARD open (sheet or not),
  // heartbeat-refreshed, in-memory (rebuilds from heartbeats after eviction).
  readonly #boardClients = new Map<string, { at: number; name: string }>();

  /** Announce (or clear, with null name) one client viewing the board. */
  async boardPresent(clientId: string, name: string | null): Promise<void> {
    await this.#assertCreated();
    if (name === null) this.#boardClients.delete(clientId);
    else this.#boardClients.set(clientId, { at: Date.now(), name: name.slice(0, 80) });
  }

  /** Fresh caret presence per live session — "who has this file open".
   * Index-matched flat arrays on the wire (one entry per path+client pair):
   * Record-of-array values break the generated capnweb promise-mapped
   * types, the same family of rule CollabChanges documents. */
  async collabPresenceSummary(): Promise<CollabPresenceFlat> {
    await this.#assertCreated();
    const paths: string[] = [];
    const clientIds: string[] = [];
    for (const [path, ids] of Object.entries(this.#collab.presenceSummary())) {
      for (const clientId of ids) {
        paths.push(path);
        clientIds.push(clientId);
      }
    }
    return { clientIds, paths };
  }

  /** Everyone with the BOARD open (heartbeats): clientId -> display name.
   * A flat Record on the wire — nesting breaks the generated capnweb
   * promise-mapped types (same family of rule as CollabChanges). */
  async collabBoardViewers(): Promise<Record<string, string>> {
    await this.#assertCreated();
    const now = Date.now();
    for (const [clientId, client] of this.#boardClients) {
      if (now - client.at > 45_000) this.#boardClients.delete(clientId);
    }
    return Object.fromEntries(
      [...this.#boardClients]
        .map(([clientId, client]) => [clientId, client.name] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  // -- git -------------------------------------------------------------------------

  async gitStatus(): Promise<WorkspaceStatus> {
    await this.#assertCreated();
    await this.#effectiveMounts({ refresh: true });
    return this.#collab.barrier(() => this.#core.gitStatus());
  }

  async gitCommit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
    await this.#assertCreated();
    await this.#effectiveMounts({ refresh: true });
    const resolved =
      input.scope === undefined ? input : { ...input, scope: this.#resolvePath(input.scope) };
    // Settle → commit → stamp as ONE fence: no flush timer, open, or
    // configure can interleave, and baselines advance mount-scoped to
    // exactly what the commit contained (a commit never spans mounts;
    // stamping another mount's session would erase its redline). ownsPath
    // routes against the EXACT table the commit classified with — the core
    // returns it — never a live table a concurrent refresh (getConfig, a
    // routing miss, a repo created mid-commit) could move under the stamp.
    let classifiedMounts: Record<string, WorkspaceMount> = {};
    return this.#collab.commitBarrier(
      async () => {
        const { mounts, ...result } = await this.#core.gitCommit(resolved);
        classifiedMounts = mounts;
        return result;
      },
      (path, mount) => routeMount(classifiedMounts, path)?.mountPath === mount,
    );
  }

  async gitLog(input: WorkspaceGitLogInput = {}): Promise<WorkspaceGitLogEntry[]> {
    await this.#assertCreated();
    await this.#effectiveMounts({ refresh: true });
    const resolved =
      input.scope === undefined ? input : { ...input, scope: this.#resolvePath(input.scope) };
    return this.#core.gitLog(resolved);
  }
}
