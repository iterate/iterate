import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import type {
  StreamEventInput,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "iterate/processors";
import { isStreamOffsetConflictError } from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceCommitInput,
  WorkspaceCommitResult,
  WorkspaceGitLogEntry,
  WorkspaceGitLogInput,
  WorkspaceStatus,
} from "./types.ts";
import {
  WorkspaceProcessorContract,
  type WorkspaceConfig,
  type WorkspaceConfigPatch,
} from "./workspace-processor-contract.ts";
import {
  mergeWorkspaceConfigPatch,
  WorkspaceProcessor,
} from "./workspace-processor-implementation.ts";
import { WorkspaceCore, type MountRepoAccess } from "./workspace-core.ts";
import { normalizeWorkspaceMountKeys } from "./utils.ts";

const PROCESSOR_SLUG = WorkspaceProcessorContract.slug;
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
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  // NO recovery on purpose: WorkspaceProcessor is a pure reducer (no
  // processEvent, no runInBackground), so an eviction can never lose
  // consequential background work (see the registry module doc's rule).
  readonly #workspaceProcessor = this.#registry.register(
    new WorkspaceProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  // Runner-backed reads: the runner owns the cursors; every read this DO
  // serves goes through the runner's committed progress.
  readonly #reads = this.#registry.reads(this.#workspaceProcessor);

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
    // so this thunk reads already-fresh reduced state.
    mounts: async () => this.#currentConfig().mounts,
    repo: (repoPath) => this.#repoStub(repoPath),
    workspace: this.#workspace,
  });

  #repoStub(repoPath: string): MountRepoAccess {
    return this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({ path: repoPath, projectId: this.#name.projectId }),
    );
  }

  #currentConfig(): WorkspaceConfig {
    return this.#reads.currentState.config;
  }

  /** Pull the reduced state current and require an explicit birth certificate.
   * STRICT catch-up (throws): every public operation routes and
   * classifies against `currentState.config`, and a swallowed catch-up failure
   * would let it proceed on a stale mount table — misrouting reads and commits
   * — when a committed `configured` event exists but has not reduced. Failing
   * the operation loudly is the only safe disposition. */
  async #assertCreated(): Promise<void> {
    await this.#reads.catchUp();
    if (this.#reads.currentState.birthCertificate !== null) return;
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
    plan: (current: WorkspaceConfig) => WorkspaceConfigPatch | null,
  ): Promise<WorkspaceConfig> {
    for (let attempt = 1; attempt <= MAX_CONFIGURE_ATTEMPTS; attempt++) {
      // Pin BOTH heads in one read: the reduction barrier waits for the
      // DURABLE head — a processor catch-up never sees ephemeral rows, so
      // waiting for the raw head would wedge on a trailing ephemeral suffix —
      // while the CAS below asserts against the RAW head, where offsets are
      // actually assigned. waitUntilEvent THROWS on a wedged catch-up, so a
      // stale runner can never validate a plan or report convergence
      // silently; the exact-offset append turns any raw/durable skew into a
      // plain conflict retry.
      const { maxDurableOffset, maxOffset: rawHead } =
        await this.#stream.durableObjectStub.getHeadOffsets();
      await this.#reads.waitUntilEvent({
        offset: maxDurableOffset,
        timeoutMs: INGEST_WAIT_TIMEOUT_MS,
      });
      const current = this.#currentConfig();
      const patch = plan(current);
      if (patch === null) return current;
      const next = mergeWorkspaceConfigPatch(current, patch);
      // Ownership/collision safety, judged inside the lock against the exact
      // tables this append will transition between.
      await this.#core.assertMountTransitionSafe(current.mounts, next.mounts);
      try {
        const [event] = await this.#stream.append({
          ...WorkspaceProcessorContract.buildEvent({
            type: "events.iterate.com/workspace/configured",
            payload: { config: patch },
          }),
          offset: rawHead + 1,
        } as StreamEventInput);
        await this.#reads.catchUp();
        await this.#reads.waitUntilEvent({
          offset: event!.offset,
          timeoutMs: INGEST_WAIT_TIMEOUT_MS,
        });
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

  /** The reduced configuration (birth certificate + configured patches). */
  async getConfig(): Promise<WorkspaceConfig> {
    await this.#assertCreated();
    return this.#currentConfig();
  }

  /**
   * Append a `workspace/configured` patch and return the resulting reduced
   * config (read-your-writes: the command only returns once the reduced state
   * provably includes the event it appended). The patch deep-merges per mount point:
   * unknown keys add mounts, partial values edit existing mounts, `null`
   * removes one. The MERGED result is validated here before the append, so a
   * patch that would leave a broken table fails loudly at the door.
   */
  async configure(input: { config: WorkspaceConfigPatch }): Promise<WorkspaceConfig> {
    await this.#assertCreated();
    const config: WorkspaceConfigPatch =
      input.config.mounts === undefined
        ? input.config
        : { ...input.config, mounts: normalizeWorkspaceMountKeys(input.config.mounts) };
    // Serialized with the core's mutations and commits: an unmount or repo
    // swap must never interleave a commit that already classified against the
    // old table.
    return this.#core.runExclusive(() =>
      this.#applyConfigTransition((current) => {
        // The reduce is deliberately TOLERANT (a committed event must never
        // wedge the reducer), so the door supplies the loudness — validated
        // against the exact state this append will land on (the offset
        // assertion makes an interleaved append a retry, not a silent drop):
        // every non-null patch entry must survive into a complete mount.
        const merged = mergeWorkspaceConfigPatch(current, config);
        for (const [key, value] of Object.entries(config.mounts ?? {})) {
          if (value !== null && !(key in merged.mounts)) {
            throw new Error(
              `mount "${key}" patch does not produce a complete mount — new mounts need { repoPath, policy }`,
            );
          }
        }
        return config;
      }),
    );
  }

  // -- filesystem ----------------------------------------------------------------

  async readFile(path: string): Promise<string | null> {
    await this.#assertCreated();
    return this.#core.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    await this.#assertCreated();
    return this.#core.readFileBytes(path);
  }

  async exists(path: string): Promise<boolean> {
    await this.#assertCreated();
    return this.#core.exists(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#assertCreated();
    return this.#core.writeFile(path, content);
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    await this.#assertCreated();
    return this.#core.writeFileBytes(path, data);
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    await this.#assertCreated();
    return this.#core.edit(input);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.#assertCreated();
    return this.#core.deleteFile(path);
  }

  async listAllFiles(): Promise<string[]> {
    await this.#assertCreated();
    return this.#core.listAllFiles();
  }

  async glob(pattern: string): Promise<string[]> {
    await this.#assertCreated();
    return this.#core.glob(pattern);
  }

  async reset(): Promise<void> {
    await this.#assertCreated();
    return this.#core.reset();
  }

  async revert(path: string): Promise<void> {
    await this.#assertCreated();
    return this.#core.revert(path);
  }

  // -- git -------------------------------------------------------------------------

  async gitStatus(): Promise<WorkspaceStatus> {
    await this.#assertCreated();
    return this.#core.gitStatus();
  }

  async gitCommit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
    await this.#assertCreated();
    return this.#core.gitCommit(input);
  }

  async gitLog(input: WorkspaceGitLogInput = {}): Promise<WorkspaceGitLogEntry[]> {
    await this.#assertCreated();
    return this.#core.gitLog(input);
  }

  // -- processor host plumbing -----------------------------------------------------

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  get processor() {
    // Runner-backed reads (#reads), never the processor instance — instance
    // reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(PROCESSOR_SLUG),
    });
  }
}
