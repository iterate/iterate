import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import { InMemoryFs } from "@cloudflare/shell";
import { createGit, type GitLogEntry } from "@cloudflare/shell/git";
import { LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { filterWorkerSnapshotPaths } from "../workers/source-masks.ts";
import { walkWorkspaceFiles, wipeWorkspace } from "../../lib/shell-fs.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { parseConfig } from "../../config.ts";
import {
  createCloudflareAccountApi,
  ensureArtifactRepoEventSubscriptionForWorker,
} from "../events/cloudflare-event-subscriptions.ts";
import {
  assertGithubInstallationTokenMintAuthorized,
  mintGithubInstallationToken,
} from "../integrations/github-app.ts";
import { ITERATE_GITHUB_BOT_COMMIT_AUTHOR } from "../integrations/utils.ts";
import type {
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  EditRepoFileInput,
  EditRepoFileResult,
  GithubRepoLink,
  GithubResetResult,
  GithubSyncResult,
  RepoCommitDetails,
  RepoFileChange,
  RepoLogCommit,
  RepoLogResult,
} from "./types.ts";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import { replaceArtifactWithEmptyRepo } from "./artifact-replacement.ts";
import {
  readCheckoutBytes,
  readCheckoutFileBytes,
  readCheckoutFiles,
  readCheckoutTextFile,
  repoContentHash,
  walkCheckoutPaths,
} from "./checkout-files.ts";
import { diffFileMaps } from "./line-diff.ts";
import {
  RepoArtifactNameCodec,
  RepoNotSeededError,
  base64ToBytes,
  bytesToBase64,
  classifyRepoAccessError,
  gitBranchContainsCommit,
  isRepoNotSeededError,
} from "./utils.ts";
import { projectRepoSeedFiles } from "./project-repo-seed.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-defaults.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { linkRepoToGithub } from "./github-link.ts";
import {
  decideHeadResolution,
  isObservedPushRecord,
  observeExternalPushTransition,
  recordOwnPushTransition,
  shouldRetryHeadResolution,
  type ObservedPush,
  type RepoHeadAuthority,
} from "./repo-head-authority.ts";
import { diffRepoTaskFiles, type RepoCommittedFileChange } from "./repo-task-events.ts";
import { SingleFlightValue } from "./single-flight-value.ts";
import { githubFastForwardTransferDepth, githubSyncBaseCommitOid } from "./github-sync-utils.ts";
import { importGithubArtifactWithInitialPushCapture } from "./artifact-import.ts";
import { getOrCreateArtifact } from "./artifact-creation.ts";

const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const ARTIFACT_HEAD_VISIBILITY_RETRIES = 5;
// Artifact creation is an at-least-once obligation. Concurrent first drives
// must produce the same root commit instead of racing two timestamped seeds.
const REPO_SEED_COMMIT_TIMESTAMP_SECONDS = 1_577_836_800;
const REPO_DIR = "/repo";
const TASK_FILE_INCLUDE_PATTERNS = [
  "tasks/**/*.md",
  "tasks/**/*.markdown",
  "**/tasks/**/*.md",
  "**/tasks/**/*.markdown",
];

// The durable GitHub link record: the mirror-push hot path (every commit)
// reads it from KV instead of re-folding the stream. The link lifecycle events
// on the repo stream are the record of TRUTH for inspection; this key is
// written in the same methods that append them, so the two cannot drift.
const GITHUB_LINK_KV_KEY = "github-link:v1";

// The durable HEAD-tree cache's materialized commit oid (default branch only).
// Presence doubles as the "materialized once" sentinel; every HEAD read
// compares it against the durable head cursor and re-materializes only when
// main actually moved.
const REPO_HEAD_TREE_KEY = "repo-head-tree:v1";

type RepoHead = {
  branch: string;
  commitOid: string;
  contentHash: string;
};

export class RepoDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });
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
  // The DO constructs the processor — no host-injected readState/writeState/
  // keepAliveWhile deps; the runner owns durable progress and keepalive.
  // Registered WITH recovery: creation and GitHub imports are consequential
  // `runInBackground` work (journaled requested/started obligations whose
  // OUTCOME matters). An incarnation that dies owing either must be revived.
  // The keepalive alarm appends the `stream/processor-revived` fact, whose
  // ordinary delivery lands at head and lets the at-head reconcile re-drive
  // the obligations (see the registry module doc's recovery rule).
  readonly #repoProcessor = this.#registry.register(
    new RepoProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      // Creation and public mutations all move the same branch. A recovered
      // creation attempt is retry-safe, but it must not move the ref between a
      // mutation's checked clone and push.
      createEmptyArtifact: () => this.#serializeWrite(() => this.createEmptyArtifactRepo()),
      importPublicGithubArtifact: (input) =>
        this.#serializeWrite(() => this.importPublicGithubArtifact(input)),
      linkGithub: async (input) => {
        if (this.#name.projectId === null) {
          throw new Error("GitHub-backed repos require a project-scoped repo.");
        }
        await linkRepoToGithub(
          {
            ...input,
            projectId: this.#name.projectId,
            repoPath: this.#name.path,
          },
          {
            repo: {
              configureGithubLink: (link) => this.configureGithubLink(link),
              getGithubLink: () => this.getGithubLink(),
              pushToGithub: (pushInput) => this.pushToGithub(pushInput),
            },
            // The saga is about to adopt GitHub. Pushing starter history first
            // would be wasted for a public import and rejected for an existing
            // private repository.
            skipInitialPush: true,
          },
        );
      },
      syncPrivateGithub: async () => {
        await this.syncFromGithub({ depth: 1, force: true });
      },
      // Sync the current GitHub head, not necessarily the delivery's SHA:
      // GitHub webhooks may arrive out of order, and adopting a newer head
      // also satisfies every older push delivery. syncFromGithub derives a
      // bounded depth that still retains the previous Artifacts head.
      syncFromGithubPush: async () => await this.syncFromGithub({ depth: 1 }),
      observeArtifactPush: (input) =>
        this.#observeExternalPush(input.branch, {
          afterCommitOid: input.afterCommitOid,
          beforeCommitOid: input.beforeCommitOid,
        }),
      taskChangesForArtifactPush: (input) => this.#taskChangesForArtifactPush(input),
    }),
    { recovery: true },
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (the processor facade, live state) goes through the
  // runner's committed progress.
  readonly #reads = this.#registry.reads(this.#repoProcessor);

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#reads), never the processor instance — see the
    // field comment: instance reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(RepoProcessorContract.slug),
    });
  }

  /** The repo's live state — the get/set/assign/subscribe surface behind `itx.repos.get(path).liveState`. */
  get liveState() {
    return new LiveStateRpcTarget(this.#registry);
  }

  /**
   * The head of a branch, resolved from a durable cache on the hot path.
   * Every write to the repo goes through this Durable Object (`commitFiles`
   * and seeding), so the cache is authoritative once written; a cold miss
   * repairs it with one shallow clone. The worker build resolver calls this on
   * every branch-late-bound worker load, which is what makes a repo commit
   * visible on the next use without a per-load clone.
   *
   * `contentHash` identifies the checkout's file contents (a poor man's git
   * tree oid — the porcelain doesn't expose trees). Build keys prefer it over
   * the commit oid so repos with identical content — every freshly seeded
   * project repo — share one build artifact instead of each paying a bundler
   * run and npm install.
   */
  async getHead(input: { branch?: string } = {}): Promise<RepoHead> {
    const branch = input.branch ?? REPO_DEFAULT_BRANCH;
    const cached = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    if (isRepoHeadRecord(cached)) return { branch, ...cached };

    const snapshot = await this.getFilesSnapshot({ branch });
    const head = {
      commitOid: snapshot.commitOid,
      contentHash: await repoContentHash(snapshot.files),
    };

    // The clone above yields to other calls on this object. A head that
    // appeared meanwhile came from `commitFiles`/seeding — the authorities —
    // and may be NEWER than this checkout; writing ours over it would serve a
    // stale head forever (the cache never self-invalidates).
    const raced = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    if (isRepoHeadRecord(raced)) return { branch, ...raced };
    // Same staleness rule against the branch authority: a checkout that lags
    // the last own push, or that cannot settle an observed external push
    // (retries exhausted against a lagging replica), may be SERVED once, but
    // must never be CACHED — an un-invalidatable cache entry would pin builds
    // to the pre-push head forever.
    const decision = decideHeadResolution(this.#branchAuthority(branch), head.commitOid);
    if (!decision.cache) return { branch, ...head };
    this.ctx.storage.kv.put(repoHeadStorageKey(branch), head);
    return { branch, ...head };
  }

  /**
   * A masked file snapshot at a branch head or pinned commit — the repo file
   * source for the worker build pipeline, and the one clone-and-read pathway
   * every read on this object goes through. Include/exclude globs bound what
   * becomes build input.
   *
   * With `commitOid`, `branch` names where that commit lives (git clones are
   * single-branch): worker builds pin a late-bound branch ref to the head it
   * saw, so the pinned commit is only reachable through its branch's history.
   */
  async getFilesSnapshot(
    input: {
      branch?: string;
      commitOid?: string;
      exclude?: string[];
      include?: string[];
    } = {},
  ): Promise<{ commitOid: string; files: Record<string, string> }> {
    const branch = input.branch ?? REPO_DEFAULT_BRANCH;
    const cacheable =
      branch === REPO_DEFAULT_BRANCH &&
      input.commitOid === undefined &&
      input.exclude === undefined &&
      input.include === undefined;
    if (cacheable) {
      return this.#headFilesSnapshot.get(
        () => this.#loadFilesSnapshot({ ...input, branch }),
        (snapshot) => {
          // #checkout deliberately returns its last clone after the bounded
          // eventual-consistency retries. Let current callers use that result,
          // but never retain it while the branch authority calls it stale.
          return decideHeadResolution(this.#branchAuthority(branch), snapshot.commitOid).cache;
        },
      );
    }
    return this.#loadFilesSnapshot(input);
  }

  async #loadFilesSnapshot(
    input: {
      branch?: string;
      commitOid?: string;
      exclude?: string[];
      include?: string[];
    } = {},
  ): Promise<{ commitOid: string; files: Record<string, string> }> {
    const { filesystem, head } = await this.#checkout(input);

    // Mask paths BEFORE reading contents: an excluded tree (a committed
    // node_modules/, build output) should cost a directory walk, not reads.
    const paths = await walkCheckoutPaths(filesystem, REPO_DIR);
    const selected = filterWorkerSnapshotPaths(paths.sort(), {
      exclude: input.exclude,
      include: input.include,
    });
    const files: Record<string, string> = {};
    for (const path of selected) {
      files[path] = await readCheckoutTextFile(filesystem, `${REPO_DIR}/${path}`);
    }
    return { commitOid: head.oid, files };
  }

  /**
   * A checked-out filesystem at a branch head or pinned commit — the one
   * clone pathway every read on this object goes through (file snapshots and
   * single-file reads alike). `historyDepth` controls how much history the
   * branch clone carries: the default 1 for content reads, a number for
   * bounded history (`log` — isomorphic-git records the shallow boundary in
   * `.git/shallow` and stops walking there), `"full"` when parents must be
   * checkout-able (`commitDetails`).
   */
  async #checkout(
    input: { branch?: string; commitOid?: string; historyDepth?: number | "full" } = {},
  ): Promise<{
    branch: string;
    filesystem: InMemoryFs;
    git: ReturnType<typeof createGit>;
    head: { oid: string };
  }> {
    const repo = await this.gitAccess();
    const branch = input.branch ?? repo.defaultBranch;
    const credentials = { password: repo.token, username: "x" };
    // Read-your-write over the eventually consistent Artifacts remote: a
    // clone right after a push can serve the previous HEAD (#recordPushedHead
    // has the full story). BOTH paths retry against the branch authority
    // (own-push floor + observed external pushes) — a pinned read of a
    // just-pushed commit (the History diff pane's flow: commit → expand →
    // click a file) fails its checkout on a stale clone for exactly the same
    // reason a branch read serves the previous head. The authority is re-read
    // each attempt so an observation landing mid-retry is honored.

    if (input.commitOid !== undefined) {
      for (let attempt = 1; ; attempt++) {
        // Pinned commits need history: a shallow clone only contains the
        // branch tip. Project repos are small; correctness beats depth tuning.
        const filesystem = new InMemoryFs();
        const git = createGit(filesystem, REPO_DIR);
        let branchHead: { oid: string } | undefined;
        try {
          await git.clone({ branch, url: repo.remote, ...credentials });
          [branchHead] = await git.log({ depth: 1, ref: branch });
        } catch (error) {
          throw classifyRepoAccessError(error, branch);
        }
        if (!branchHead) throw new RepoNotSeededError("Repo has no commits.");
        try {
          await git.checkout({ ref: input.commitOid, force: true });
        } catch (error) {
          // A clone still BEHIND the branch authority may simply predate the
          // pinned commit — retryable. A caught-up clone that lacks the oid
          // means the oid genuinely is not on this branch: fail fast.
          if (
            shouldRetryHeadResolution(this.#branchAuthority(branch), branchHead.oid) &&
            attempt <= 5
          ) {
            console.warn(
              `repo pinned clone is behind the branch authority (saw ${branchHead.oid}); retry ${attempt} for ${input.commitOid}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }
          throw error;
        }
        const [head] = await git.log({ depth: 1 });
        if (!head) throw new Error("Repo has no commits.");
        if (head.oid !== input.commitOid) {
          throw new Error(`Repo checkout of ${input.commitOid} landed on ${head.oid}.`);
        }
        return { branch, filesystem, git, head };
      }
    }

    const clone = async () => {
      const filesystem = new InMemoryFs();
      const git = createGit(filesystem, REPO_DIR);
      let head: { oid: string } | undefined;
      try {
        await git.clone({
          branch,
          ...(input.historyDepth === "full" ? {} : { depth: input.historyDepth || 1 }),
          singleBranch: true,
          url: repo.remote,
          ...credentials,
        });
        [head] = await git.log({ depth: 1, ref: branch });
      } catch (error) {
        throw classifyRepoAccessError(error, branch);
      }
      if (!head) throw new RepoNotSeededError("Repo has no commits.");
      return { filesystem, git, head };
    };

    let { filesystem, git, head } = await clone();
    for (
      let attempt = 1;
      shouldRetryHeadResolution(this.#branchAuthority(branch), head.oid) && attempt <= 5;
      attempt++
    ) {
      console.warn(`repo clone is behind the branch authority (saw ${head.oid}); retry ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      ({ filesystem, git, head } = await clone());
    }
    return { branch, filesystem, git, head };
  }

  whoami(): string {
    return `repo ${this.#name.projectId}:${this.#name.path}`;
  }

  // Writes serialize on this chain: the clone/commit/push inside a write
  // yields the DO input gate at every network await, so two interleaved
  // writes would otherwise clone the same head and the second (non-fast-
  // forward) push would clobber the first commit — while both callers got a
  // success result. All writes funnel through this one DO by design, which
  // makes a local chain a sufficient lock. Artifacts clones can still lag a
  // completed push, so mutateArtifactRepo also verifies that its branch HEAD
  // is the last pushed commit before it changes anything.
  #writeChain: Promise<unknown> = Promise.resolve();
  // Secondary repos have no root-workspace cache. Their HEAD reads otherwise
  // clone the complete Artifact once per call; a task board opening 42 files
  // concurrently therefore launched 42 full monorepo clones and reset this
  // isolate for exceeding memory. Share one immutable HEAD snapshot until a
  // write or queue-observed external push invalidates it.
  readonly #headFilesSnapshot = new SingleFlightValue<{
    commitOid: string;
    files: Record<string, string>;
  }>();

  // The durable HEAD-tree cache: main's checkout materialized into THIS
  // object's own SQLite (files past the inline threshold spill to R2),
  // refreshed only when the durable head cursor moves. HEAD reads
  // (readFile / listFiles / listTaskFiles) serve from it with no clone and no
  // Artifacts round trip in steady state — and unlike the in-memory snapshot
  // above, it survives eviction, so a cold incarnation answers its first read
  // without re-cloning. Successor of the old per-project "root workspace"
  // cache, co-located with the head cursor so freshness is a local kv read
  // (the cross-DO re-entrant getHead dance is gone with it).
  readonly #headTreeCache = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.name,
    r2: this.env.FILES_BUCKET,
    r2Prefix: `repo-head-cache/${this.ctx.id.name!}`,
  });
  // ONE chain serializes every cache read AND materialization: a reader can
  // never interleave a refresh's wipe-and-rewrite, so no read observes a
  // half-written tree or mixed generations. Cache reads are cheap SQLite
  // lookups; queuing them behind at most one refresh is the whole cost.
  #headTreeChain: Promise<unknown> = Promise.resolve();

  #withHeadTree<T>(read: (commitOid: string) => Promise<T>): Promise<T> {
    const run = async () => {
      // The durable cursor is consulted directly — when it and the tree agree
      // there is NO clone anywhere on this path. When either is missing or
      // stale, ONE materialization (one checkout) refreshes both.
      const record = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(REPO_DEFAULT_BRANCH));
      const cached = this.ctx.storage.kv.get<string>(REPO_HEAD_TREE_KEY);
      if (isRepoHeadRecord(record) && cached === record.commitOid) return read(cached);
      return read(await this.#materializeHeadTree());
    };
    const result = this.#headTreeChain.then(run, run);
    this.#headTreeChain = result.catch(() => {});
    return result;
  }

  /**
   * ONE checkout fills everything: the byte tree, and — when the durable head
   * record is absent — the head record itself (text snapshot + contentHash),
   * with the same raced-authority and behind-push guards `getHead` applies.
   * An external push therefore costs one clone, not getHead's plus this one.
   */
  async #materializeHeadTree(): Promise<string> {
    // The key comes off BEFORE the wipe: if the write below dies, reads must
    // find "no cache" and re-materialize — never an empty tree labeled main.
    this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
    await wipeWorkspace(this.#headTreeCache);
    const { filesystem, head } = await this.#checkout({});
    const files: Record<string, string> = {};
    for (const path of await walkCheckoutPaths(filesystem, REPO_DIR)) {
      const bytes = await readCheckoutFileBytes(filesystem, `${REPO_DIR}/${path}`);
      await this.#headTreeCache.writeFileBytes(`/${path}`, bytes);
      // Text view for the contentHash — same lossy decode as the snapshot
      // lane, so both derivations of a head record hash identically.
      files[path] = await readCheckoutTextFile(filesystem, `${REPO_DIR}/${path}`);
    }
    const branch = REPO_DEFAULT_BRANCH;
    // The hash is computed BEFORE the authority checks: its await yields the
    // input gate, and a commit landing in that window must win. The checks
    // and both puts below are synchronous, so nothing can interleave them.
    const contentHash = await repoContentHash(files);
    // Never RECORD state the branch authority calls stale (the bounded clone
    // retries can exhaust): serve it once, and let the next read's cursor
    // comparison drive another materialization toward the settled head. The
    // authority is read HERE, after the last await — an observation that
    // landed while this clone ran must veto this fill's publication.
    const decision = decideHeadResolution(this.#branchAuthority(branch), head.oid);
    // A head record that appeared while this clone ran came from the write
    // authorities and may be NEWER — never overwrite it (getHead's rule).
    const raced = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    if (decision.cache && !isRepoHeadRecord(raced)) {
      this.ctx.storage.kv.put(repoHeadStorageKey(branch), { commitOid: head.oid, contentHash });
    }
    if (decision.cache) this.ctx.storage.kv.put(REPO_HEAD_TREE_KEY, head.oid);
    return head.oid;
  }

  /**
   * Verified cache read: shell serves EMPTY content when a spilled R2 body is
   * gone (preview buckets expire objects while the SQLite row and sentinel
   * survive), so a size mismatch against the row's metadata is cache
   * corruption — thrown, which invalidates the tree and falls back to the
   * authoritative clone lane. Never serve emptiness as truth.
   */
  async #readHeadTreeBytesVerified(path: string): Promise<Uint8Array | null> {
    const stat = await this.#headTreeCache.stat(`/${path}`);
    if (stat === null || stat.type === "directory") return null;
    const bytes = await this.#headTreeCache.readFileBytes(`/${path}`);
    if (bytes === null || bytes.byteLength !== stat.size) {
      throw new Error(
        `head-tree cache lost the bytes of "${path}" (stat ${stat.size}, read ${bytes?.byteLength ?? "null"})`,
      );
    }
    return bytes;
  }

  #serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(write, write);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    return this.#serializeWrite(() => this.#commitFiles(input));
  }

  async #commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    const parsed = parseCommitFilesInput(input);
    const repo = await this.gitAccess();
    const branch = parsed.branch ?? repo.defaultBranch;
    const result = await commitFilesToArtifactRepo({
      author: parsed.author,
      branch,
      changes: parsed.changes,
      expectedCommitOid: this.ctx.storage.kv.get<string>(repoPushedHeadStorageKey(branch)),
      message: parsed.message,
      remote: repo.remote,
      token: repo.token,
    });
    this.#recordPushedHead(result);

    // `commitFiles()` is our read-your-write boundary: once it returns, the
    // durable head cache names the pushed commit, so the next worker source
    // resolution builds from it.
    this.ctx.storage.kv.put(repoHeadStorageKey(result.branch), {
      commitOid: result.commitOid,
      contentHash: result.contentHash,
    });
    if (!result.noChanges) {
      this.#scheduleGithubMirrorPush(result.branch);
    }

    return {
      branch: result.branch,
      changedPaths: result.changedPaths,
      commitOid: result.commitOid,
      noChanges: result.noChanges,
    };
  }

  edit(input: EditRepoFileInput): Promise<EditRepoFileResult> {
    return this.#serializeWrite(() => this.#edit(input));
  }

  async #edit(input: EditRepoFileInput): Promise<EditRepoFileResult> {
    const parsed = parseEditRepoFileInput(input);
    const repo = await this.gitAccess();
    const branch = parsed.branch ?? repo.defaultBranch;
    const result = await editArtifactRepoFile({
      author: parsed.author,
      branch,
      expectedCommitOid: this.ctx.storage.kv.get<string>(repoPushedHeadStorageKey(branch)),
      message: parsed.message,
      newString: parsed.newString,
      oldString: parsed.oldString,
      path: parsed.path,
      remote: repo.remote,
      replaceAll: parsed.replaceAll,
      token: repo.token,
    });
    this.#recordPushedHead(result);

    // Same read-your-write boundary as commitFiles(): the durable head cache
    // names the pushed commit before the RPC resolves.
    this.ctx.storage.kv.put(repoHeadStorageKey(result.branch), {
      commitOid: result.commitOid,
      contentHash: result.contentHash,
    });
    if (!result.noChanges) {
      this.#scheduleGithubMirrorPush(result.branch);
    }

    return {
      branch: result.branch,
      changedPaths: result.changedPaths,
      commitOid: result.commitOid,
      noChanges: result.noChanges,
      occurrenceCount: result.occurrenceCount,
      path: result.path,
    };
  }

  async #taskFilesSnapshot(branch: string, commitOid: string): Promise<Record<string, string>> {
    return (
      await this.getFilesSnapshot({
        branch,
        commitOid,
        include: TASK_FILE_INCLUDE_PATTERNS,
      })
    ).files;
  }

  async #taskChangesForArtifactPush(input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }): Promise<RepoCommittedFileChange[]> {
    // This method is reached from the Cloudflare Artifacts queue for pushes
    // made outside this DO too (for example from a developer's computer).
    // Record the queue-observed head before pinned diff reads. Artifacts can
    // briefly clone the previous tip even after emitting its push event; the
    // recorded oid makes #checkout retry that stale clone instead of letting
    // it repopulate the just-cleared unpinned HEAD snapshot.
    this.#observeExternalPush(input.branch, {
      afterCommitOid: input.afterCommitOid,
      beforeCommitOid: input.beforeCommitOid,
    });
    const previous =
      input.beforeCommitOid === null
        ? {}
        : await this.#taskFilesSnapshot(input.branch, input.beforeCommitOid);
    const current =
      input.afterCommitOid === null
        ? {}
        : await this.#taskFilesSnapshot(input.branch, input.afterCommitOid);
    return diffRepoTaskFiles(previous, current);
  }

  /**
   * The Artifacts git endpoint is eventually consistent: a clone issued right
   * after a successful push can still serve the previous HEAD (observed in
   * preview e2e — repo.edit() committed, the immediate readFile() returned the
   * pre-edit content). Every push records its commit oid here, and the
   * branch-head clone in getFilesSnapshot retries briefly until it observes at
   * least that head, giving the DO read-your-write semantics over the remote.
   * A concurrent writer may advance HEAD past the recorded oid; the retry loop
   * treats any DIFFERENT head as possibly-newer only after exhausting its
   * attempts.
   */
  /**
   * Queue-delivered push observation. Cloudflare Queues does not guarantee
   * publication-order delivery, and commit oids carry no order — so external
   * observations NEVER assign cursors. Each observation joins the branch's
   * observed `(before, after)` window; the chain's FRONTIER (afters no
   * observed push builds upon) is the only set of resolutions the clone
   * lanes may durably cache — anything else (an eventually consistent
   * replica still serving any pre-push tip, or a push delivered out of
   * order) is served once, uncached ({@link decideHeadResolution}). A `null`
   * after records a ref deletion. Redeliveries and provably-superseded late
   * pushes change nothing and keep the warm cache. The DO's own serialized
   * write lanes stay on {@link #recordPushedHead} — their pushes really are
   * ordered.
   */
  #observeExternalPush(branch: string, push: ObservedPush) {
    const transition = observeExternalPushTransition(this.#branchAuthority(branch), push);
    this.#writeBranchAuthority(branch, transition.authority);
    if (!transition.invalidate) return;
    if (branch === REPO_DEFAULT_BRANCH) {
      this.#headFilesSnapshot.clear();
      this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
    }
    this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
  }

  #recordPushedHead(result: {
    branch: string;
    commitOid: string;
    noChanges?: boolean;
    parentCommitOid?: string;
  }) {
    if (result.noChanges) return;
    // The push's parent must reach the observed window so that superseded tip
    // is pruned from the frontier — otherwise, after an observation deleted
    // the head record, an own commit would record (null -> new) and leave its
    // real parent cacheable once the floor moves on. The commit lanes pass
    // their checked clone's TRUE parent; lanes without one (GitHub adoption
    // force-pushes) fall back to the pre-push head record, whose oid is
    // exactly the tip that write superseded. A missing record reads as null,
    // which prunes nothing: safe.
    const previous = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(result.branch));
    const beforeCommitOid =
      result.parentCommitOid ?? (isRepoHeadRecord(previous) ? previous.commitOid : null);
    if (result.branch === REPO_DEFAULT_BRANCH) {
      this.#headFilesSnapshot.clear();
      // The head moved: the tree sentinel is stale (the write lanes re-record
      // the head RECORD themselves right after this).
      this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
    }
    this.#writeBranchAuthority(
      result.branch,
      recordOwnPushTransition(this.#branchAuthority(result.branch), {
        beforeCommitOid,
        commitOid: result.commitOid,
      }),
    );
  }

  #invalidateArtifactState(branch: string) {
    if (branch === REPO_DEFAULT_BRANCH) {
      this.#headFilesSnapshot.clear();
      this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
    }
    this.#artifactTokenPromise = undefined;
    this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
    this.#writeBranchAuthority(branch, { observedPushes: [], pushedFloor: undefined });
  }

  /** The branch's head authority, read fresh from durable storage (sync). */
  #branchAuthority(branch: string): RepoHeadAuthority {
    const rawObserved = this.ctx.storage.kv.get<unknown>(repoObservedPushesStorageKey(branch));
    let observedPushes: ObservedPush[];
    if (Array.isArray(rawObserved)) {
      observedPushes = rawObserved.filter(isObservedPushRecord);
    } else if (typeof rawObserved === "string" || rawObserved === null) {
      // One-time migration from the pre-frontier scheme, which stored the
      // LAST observed after-oid bare (null = deletion). That observation is
      // still evidence — and a durable head record showing anything else may
      // be exactly the stale pin the old scheme failed to evict. Invalidate
      // it NOW: no new push may ever arrive to do it later.
      observedPushes = [{ afterCommitOid: rawObserved, beforeCommitOid: null }];
      this.ctx.storage.kv.put(repoObservedPushesStorageKey(branch), observedPushes);
      const record = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
      if (isRepoHeadRecord(record) && record.commitOid !== rawObserved) {
        this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
        if (branch === REPO_DEFAULT_BRANCH) {
          this.#headFilesSnapshot.clear();
          this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
        }
      }
    } else {
      observedPushes = [];
    }
    const pushed = this.ctx.storage.kv.get<string>(repoPushedHeadStorageKey(branch));
    return { observedPushes, pushedFloor: typeof pushed === "string" ? pushed : undefined };
  }

  #writeBranchAuthority(branch: string, authority: RepoHeadAuthority) {
    if (authority.observedPushes.length === 0) {
      this.ctx.storage.kv.delete(repoObservedPushesStorageKey(branch));
    } else {
      this.ctx.storage.kv.put(repoObservedPushesStorageKey(branch), authority.observedPushes);
    }
    if (authority.pushedFloor === undefined) {
      this.ctx.storage.kv.delete(repoPushedHeadStorageKey(branch));
    } else {
      this.ctx.storage.kv.put(repoPushedHeadStorageKey(branch), authority.pushedFloor);
    }
  }

  /**
   * Committed file contents at HEAD — or, with `commitOid`, pinned to that
   * commit — null when the path does not exist there. `encoding: "base64"`
   * reads the raw bytes (images, PDFs — anything a utf8 decode would corrupt)
   * and returns them base64-encoded. Reads serve from the clone lane's
   * shared head snapshot (one clone per head movement per incarnation).
   */
  async readFile(input: {
    path: string;
    encoding?: "utf8" | "base64";
    commitOid?: string;
  }): Promise<{ commitOid: string; content: string; path: string } | null> {
    const path = normalizeRepoFilePath(input.path);
    if (input.commitOid !== undefined) assertCommitOid(input.commitOid);
    if (input.commitOid === undefined) {
      // HEAD reads serve from the durable tree cache (no clone). The cache is
      // a CACHE: a failure invalidates it (one bounded rebuild on the next
      // read) and falls back to the authoritative clone lane, loudly.
      try {
        return await this.#withHeadTree(async (commitOid) => {
          const bytes = await this.#readHeadTreeBytesVerified(path);
          if (bytes === null) return null;
          const content =
            input.encoding === "base64" ? bytesToBase64(bytes) : new TextDecoder().decode(bytes);
          return { commitOid, content, path };
        });
      } catch (error) {
        this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
        console.warn(
          `repo head read via the head-tree cache failed; falling back to a clone: ${String(error)}`,
        );
      }
    }
    if (input.encoding === "base64") {
      const { filesystem, head } = await this.#checkout({ commitOid: input.commitOid });
      const absolutePath = `${REPO_DIR}/${path}`;
      try {
        await filesystem.lstat(absolutePath);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") return null;
        throw error;
      }
      const bytes = await readCheckoutFileBytes(filesystem, absolutePath);
      return { commitOid: head.oid, content: bytesToBase64(bytes), path };
    }
    // Exact map lookup, deliberately not an include mask: glob metacharacters
    // in a filename must not change what this reads.
    const { commitOid, files } = await this.getFilesSnapshot({ commitOid: input.commitOid });
    const content = files[path];
    return content === undefined ? null : { commitOid, content, path };
  }

  /**
   * Every task markdown file's contents at HEAD in ONE clone. The task board
   * needs the CONTENT of every `tasks/**` markdown file, not the whole tree;
   * doing that as `listFiles()` + a `readFile()` per task fans N reads at this
   * object, and on a cold snapshot each `readFile` is its own full clone — N
   * concurrent clones of a big repo is exactly what overloads this DO. The task include
   * mask is applied BEFORE contents are read (see `getFilesSnapshot`), so this
   * only ever reads the handful of task files, and its cost scales with the
   * number of tasks, not the size of the repo.
   */
  async listTaskFiles(): Promise<{ commitOid: string; files: Record<string, string> }> {
    try {
      return await this.#withHeadTree(async (commitOid) => {
        const paths = (await walkWorkspaceFiles(this.#headTreeCache))
          .map((path) => path.slice(1))
          .sort();
        const selected = filterWorkerSnapshotPaths(paths, { include: TASK_FILE_INCLUDE_PATTERNS });
        const files: Record<string, string> = {};
        for (const path of selected) {
          const bytes = await this.#readHeadTreeBytesVerified(path);
          // A listed path with no verified content is cache corruption, never
          // truth — fail to the clone lane instead of serving an empty task.
          if (bytes === null) throw new Error(`head-tree cache is missing "${path}"`);
          files[path] = new TextDecoder().decode(bytes);
        }
        return { commitOid, files };
      });
    } catch (error) {
      this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
      console.warn(
        `repo listTaskFiles via the head-tree cache failed; falling back to a clone: ${String(error)}`,
      );
    }
    return this.getFilesSnapshot({ include: TASK_FILE_INCLUDE_PATTERNS });
  }

  /** All committed file paths at HEAD (served from the durable head-tree cache). */
  async listFiles(): Promise<{ commitOid: string; paths: string[] }> {
    try {
      return await this.#withHeadTree(async (commitOid) => {
        const paths = (await walkWorkspaceFiles(this.#headTreeCache))
          .map((path) => path.slice(1))
          .sort();
        return { commitOid, paths };
      });
    } catch (error) {
      this.ctx.storage.kv.delete(REPO_HEAD_TREE_KEY);
      console.warn(
        `repo listFiles via the head-tree cache failed; falling back to a clone: ${String(error)}`,
      );
    }
    const { commitOid, files } = await this.getFilesSnapshot();
    return { commitOid, paths: Object.keys(files).sort() };
  }

  /**
   * Commit history of a branch, newest first. One depth-limited single-branch
   * clone + `git log` — deliberately WITHOUT per-commit file stats, which
   * cost a checkout of every commit and its parent; `commitDetails` computes
   * those lazily for one commit at a time (the UI's expand-a-row pattern).
   */
  async log(input: { branch?: string; limit?: number } = {}): Promise<RepoLogResult> {
    const limit = parseLogLimit(input.limit);
    // A depth-limited clone: `log` never checks anything out past the tip, so
    // the sidebar's cost stays O(limit) as history grows. isomorphic-git
    // stops the log walk at the recorded shallow boundary, and the boundary
    // commit's `parents` are reported as plain oid strings either way.
    const { branch, git } = await this.#checkout({ branch: input.branch, historyDepth: limit });
    const entries = await git.log({ depth: limit });
    return { branch, commits: entries.map(toRepoLogCommit) };
  }

  /**
   * One commit's metadata plus the files it changed versus its first parent
   * (versus an empty tree for the root commit), with numstat-shaped +/- line
   * counts. Implementation: one full clone, then checkouts of the commit and
   * its parent in the same filesystem — local tree walks, no second fetch.
   */
  async commitDetails(input: { branch?: string; commitOid: string }): Promise<RepoCommitDetails> {
    assertCommitOid(input.commitOid);
    const { branch, filesystem, git } = await this.#checkout({
      branch: input.branch,
      historyDepth: "full",
    });
    // Resolve the commit directly — the input is a validated full oid, which
    // isomorphic-git's ref resolution accepts as-is, so this stays O(1) as
    // history grows. The single-branch clone only carries branch-reachable
    // objects, so a foreign oid throws NotFound here.
    const entry = await git.log({ ref: input.commitOid, depth: 1 }).then(
      (entries) => entries[0],
      () => undefined,
    );
    if (!entry) {
      throw new Error(`Commit ${input.commitOid} was not found on branch "${branch}".`);
    }
    const parentOid = entry.parent[0] || null;

    await git.checkout({ ref: entry.oid, force: true });
    const commitFiles = await readCheckoutBytes(filesystem, REPO_DIR);
    let parentFiles = new Map<string, Uint8Array>();
    if (parentOid !== null) {
      await git.checkout({ ref: parentOid, force: true });
      parentFiles = await readCheckoutBytes(filesystem, REPO_DIR);
    }

    return { ...toRepoLogCommit(entry), files: diffFileMaps(parentFiles, commitFiles), parentOid };
  }

  // ===========================================================================
  // GitHub backing: an optional linked GitHub repository synchronized both ways.
  //
  // The Artifacts repo stays primary — commits succeed against it regardless
  // of GitHub's availability — and a best-effort push mirrors every commit.
  // git push is cumulative, so a failed mirror push self-heals on the next
  // commit; `pushToGithub` repairs on demand. GitHub push webhooks ask the repo
  // processor to fast-forward Artifacts through `syncFromGithub`; the ensuing
  // Artifacts queue event remains the sole source of commit/task facts. The
  // public sync verb is also the explicit repair/forced-adoption lane.
  // ===========================================================================

  /** The current GitHub link, or null when this repo is not linked. */
  getGithubLink(): GithubRepoLink | null {
    const stored = this.ctx.storage.kv.get<unknown>(GITHUB_LINK_KV_KEY);
    if (stored === undefined) return null;
    if (isGithubLinkRecord(stored)) return stored;
    throw new Error("Stored GitHub link does not satisfy GithubRepoLink.");
  }

  // In both link verbs the journal append comes FIRST and the KV write last:
  // the append is the only step that can fail (it crosses to the Stream DO),
  // while the synchronous KV write inside this DO cannot, so ordering them
  // this way means a failure changes nothing and the caller can just retry —
  // the journal and the KV projection never diverge.

  /** Record the GitHub link durably and journal the fact on the repo stream. */
  async configureGithubLink(link: GithubRepoLink): Promise<GithubRepoLink> {
    await this.#stream.append({
      type: "events.iterate.com/repo/github-link-configured",
      payload: { ...link },
    });
    this.ctx.storage.kv.put(GITHUB_LINK_KV_KEY, link);
    return link;
  }

  /** Remove the GitHub link; returns the removed link or null when unlinked. */
  async removeGithubLink(): Promise<GithubRepoLink | null> {
    const link = this.getGithubLink();
    if (link === null) return null;
    await this.#stream.append({
      type: "events.iterate.com/repo/github-unlinked",
      payload: {
        connection: link.connection,
        owner: link.owner,
        repo: link.repo,
        repositoryId: link.repositoryId,
      },
    });
    this.ctx.storage.kv.delete(GITHUB_LINK_KV_KEY);
    return link;
  }

  /**
   * Push the default branch head to the linked GitHub repository. Serialized
   * with commits so a mirror push never races the write it mirrors. Never
   * forced unless the caller says so — a non-fast-forward failure means GitHub
   * has commits this repo does not (someone pushed to GitHub directly); the
   * caller chooses between `pushToGithub({ force: true })` (this repo wins)
   * and `syncFromGithub()` (GitHub wins).
   */
  pushToGithub(input: { force?: boolean } = {}): Promise<{ branch: string; commitOid: string }> {
    return this.#serializeWrite(() => this.#pushToGithub(input));
  }

  async #pushToGithub(input: { force?: boolean }): Promise<{ branch: string; commitOid: string }> {
    const link = this.#requireGithubLink();
    const branch = REPO_DEFAULT_BRANCH;
    let commitOid: string | null = null;
    try {
      const repo = await this.gitAccess();
      const token = await this.#mintGithubToken(link);

      // Full single-branch clone: a mirror push must be able to send every
      // commit GitHub is missing, not just the tip. `noCheckout` because a
      // push only moves objects — materializing the working tree in the
      // in-memory fs roughly doubles peak memory for zero benefit, and the
      // 128MB isolate limit is the real bound on how big a repo can mirror.
      const clone = async () => {
        const filesystem = new InMemoryFs();
        const git = createGit(filesystem, REPO_DIR);
        await git.clone({
          branch,
          noCheckout: true,
          singleBranch: true,
          url: repo.remote,
          username: "x",
          password: repo.token,
        });
        const [head] = await git.log({ depth: 1 });
        if (!head) throw new Error("Repo has no commits.");
        return { git, head };
      };

      // Same read-your-write retry as getFilesSnapshot: the Artifacts remote
      // is eventually consistent, and a mirror push runs right after the
      // commit it mirrors — a stale clone here would push the PRE-commit head
      // to GitHub and record success, leaving the mirror silently behind
      // until the next commit.
      let { git, head } = await clone();
      const expected = this.ctx.storage.kv.get<string>(`repo-pushed-head:${branch}`);
      for (let attempt = 1; expected && head.oid !== expected && attempt <= 5; attempt++) {
        console.warn(
          `github mirror clone is behind the last push (saw ${head.oid}, pushed ${expected}); retry ${attempt}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        ({ git, head } = await clone());
      }
      commitOid = head.oid;

      await git.remote({ add: { name: "github", url: githubRemoteUrl(link) } });
      const pushed = await git.push({
        force: input.force === true,
        ref: branch,
        remote: "github",
        username: "x-access-token",
        password: token,
      });
      if (!pushed.ok) {
        throw new Error(
          `GitHub push of ${branch} was rejected (non-fast-forward means GitHub has commits this repo does not; use syncFromGithub() to adopt them or pushToGithub({ force: true }) to overwrite): ${JSON.stringify(pushed.refs)}`,
        );
      }

      await this.#stream.append({
        type: "events.iterate.com/repo/github-push-completed",
        idempotencyKey: `github-push-completed:${link.owner}/${link.repo}:${head.oid}`,
        payload: { branch, commitOid: head.oid, owner: link.owner, repo: link.repo },
      });
      return { branch, commitOid: head.oid };
    } catch (error) {
      await this.#stream
        .append({
          type: "events.iterate.com/repo/github-push-failed",
          idempotencyKey: `github-push-failed:${link.owner}/${link.repo}:${commitOid ?? "pre-clone"}:${String(error).slice(0, 80)}`,
          payload: {
            branch,
            commitOid,
            error: String(error),
            owner: link.owner,
            repo: link.repo,
          },
        })
        .catch(() => {});
      throw error;
    }
  }

  /**
   * Adopt the linked GitHub repository's default-branch head. Fast-forward
   * only: if this repo has commits GitHub does not, the sync fails and names
   * `force: true`, which discards them (they stay in the Artifacts object
   * store, unreferenced). The adopted head is live for worker builds the
   * moment this returns — same read-your-write boundary as commitFiles.
   *
   * The history transfers in-process (checkout-free clone from GitHub +
   * force-push to the Artifacts remote). `depth` is a requested lower bound;
   * a fast-forward always retains the previous Artifacts head as well so its
   * queue event can compare before/after task trees. GitHub retains the full
   * history, so a later deeper sync can widen the window.
   */
  syncFromGithub(input: { depth?: number; force?: boolean } = {}): Promise<GithubSyncResult> {
    return this.#serializeWrite(() => this.#syncFromGithub(input));
  }

  async #syncFromGithub(input: { depth?: number; force?: boolean }): Promise<GithubSyncResult> {
    const link = this.#requireGithubLink();
    const branch = REPO_DEFAULT_BRANCH;
    const previous = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    const previousCommitOid = githubSyncBaseCommitOid({
      cachedHeadCommitOid: isRepoHeadRecord(previous) ? previous.commitOid : null,
      pushedFloor: this.#branchAuthority(branch).pushedFloor,
    });
    assertGithubHistoryDepth(input.depth, "syncFromGithub");
    const token = await this.#mintGithubToken(link);

    // Fast-forward gate via the GitHub compare API: the transfer below is a
    // server-side re-import (no local history to walk), so ancestry is
    // GitHub's to answer. "identical" is the no-op; "ahead" (GitHub strictly
    // ahead of our recorded head) is the fast-forward; anything else —
    // "behind", "diverged", or a previous head GitHub has never seen —
    // requires `force`.
    const headOid = await this.#githubBranchHead({ branch, link, token });
    if (headOid === previousCommitOid) {
      return { branch, changed: false, commitOid: headOid, forced: false, previousCommitOid };
    }
    let transferDepth = input.depth;
    if (input.force !== true) {
      const comparison =
        previousCommitOid === null
          ? { aheadBy: 0, status: "unrelated" }
          : await this.#githubCompareStatus({ base: previousCommitOid, branch, link, token });
      if (comparison.status !== "ahead") {
        throw new Error(
          `syncFromGithub is not a fast-forward (GitHub says "${comparison.status}" relative to this repo's head ${previousCommitOid ?? "(none)"}). Pass force: true to discard local-only history and adopt GitHub's head.`,
        );
      }
      // The Artifacts queue projects task changes by checking out BOTH push
      // oids. Preserve the old head even when the caller requested depth 1;
      // otherwise the force-moved shallow branch makes `before` unreachable
      // and the queue-derived task projection wedges on its pinned read.
      transferDepth = githubFastForwardTransferDepth({
        aheadBy: comparison.aheadBy,
        requestedDepth: input.depth,
      });
    }
    // ONE transfer lane: clone GitHub in this isolate and force-push to the
    // Artifacts remote. Deliberately NOT the server-side Artifacts import —
    // import cannot overwrite an existing name, and the delete-then-reimport
    // dance it forces is unsafe: `artifacts.delete()` is acknowledged first
    // and applied asynchronously, so re-importing under the same name races
    // the queued delete (observed live 2026-07-10: the import won the
    // ALREADY_EXISTS retry loop, then the late delete destroyed the freshly
    // imported repo, leaving no git data at all). The cost is memory: every
    // object inflates in this isolate, so big histories need `depth` (this
    // monorepo: a 21MB pack inflates to ~290MB, past the 128MB limit); GitHub
    // keeps the full history, so a later deeper sync can widen the window.
    //
    // The get-or-create heals a repo whose Artifacts repo is missing (the
    // destroyed state the old delete+import lane could leave behind): the
    // transfer force-pushes the whole adopted history, so a brand-new empty
    // artifact is a fine starting point. A recreated artifact invalidates any
    // token minted against its predecessor — drop the cache (only then; the
    // usual already-exists case keeps the one-token-per-isolate economy).
    const artifact = await this.getOrCreateArtifact(this.artifactName());
    if (artifact.created) this.#artifactTokenPromise = undefined;
    await this.#transferGithubHistoryInProcess({
      branch,
      depth: transferDepth,
      expectedCommitOid: headOid,
      link,
      token,
    });

    // The adopted head is recorded for read-your-write, then the head cache
    // is invalidated and rebuilt through getHead's own cold-miss path (a
    // shallow depth-1 clone — head-snapshot-sized even for big repos).
    // Ordering matters: with the pushed head recorded first, getHead's
    // lags-the-push guard keeps any concurrently in-flight pre-sync checkout
    // from repopulating the cache with the old head.
    this.#recordPushedHead({ branch, commitOid: headOid });
    this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
    await this.getHead({ branch });

    await this.#stream.append({
      type: "events.iterate.com/repo/github-synced",
      idempotencyKey: `github-synced:${link.owner}/${link.repo}:${headOid}`,
      payload: {
        branch,
        commitOid: headOid,
        forced: input.force === true,
        owner: link.owner,
        previousCommitOid,
        repo: link.repo,
      },
    });
    return {
      branch,
      changed: true,
      commitOid: headOid,
      forced: input.force === true,
      previousCommitOid,
    };
  }

  /**
   * Destructively replace this repo's Artifacts repository with the linked
   * GitHub repository's default-branch history. GitHub always wins: there is
   * no ancestry check and the reset runs even when both recorded heads match.
   *
   * The GitHub clone completes before the destructive phase. Artifacts
   * deletion is asynchronous, so replacement waits until `get()` reports
   * NOT_FOUND before recreating the same addressable name; otherwise a late
   * queued deletion can destroy the freshly created replacement.
   */
  resetFromGithub(input: { depth?: number } = {}): Promise<GithubResetResult> {
    return this.#serializeWrite(() => this.#resetFromGithub(input));
  }

  async #resetFromGithub(input: { depth?: number }): Promise<GithubResetResult> {
    assertGithubHistoryDepth(input.depth, "resetFromGithub");
    const link = this.#requireGithubLink();
    const branch = REPO_DEFAULT_BRANCH;
    const previous = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    const previousCommitOid = isRepoHeadRecord(previous) ? previous.commitOid : null;
    const token = await this.#mintGithubToken(link);
    const headOid = await this.#githubBranchHead({ branch, link, token });

    // Preflight the complete source transfer before destroying anything. The
    // returned git handle owns the in-memory object database until the push.
    const git = await this.#cloneGithubHistoryInProcess({
      branch,
      depth: input.depth,
      expectedCommitOid: headOid,
      link,
      token,
    });
    const artifactName = this.artifactName();
    await replaceArtifactWithEmptyRepo(this.requireArtifacts(), artifactName, {
      beforeDelete: () => {
        // From this destructive boundary onward, neither a concurrent read nor
        // a failed replacement push may observe/cache the old Artifact head.
        this.#invalidateArtifactState(branch);
      },
    });
    await this.ensureArtifactRepoEventSubscription(artifactName);
    // Reads are not serialized with writes: one can refill the token or head
    // caches from the old Artifact while deletion is being polled. Discard
    // every possible refill after recreation, immediately before this write
    // obtains the replacement token.
    this.#invalidateArtifactState(branch);
    await this.#pushGithubHistoryInProcess({
      branch,
      git,
      repo: await this.gitAccess(),
    });

    this.#recordPushedHead({ branch, commitOid: headOid });
    this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
    await this.getHead({ branch });

    await this.#stream.append({
      type: "events.iterate.com/repo/github-synced",
      idempotencyKey: `github-reset:${link.owner}/${link.repo}:${headOid}:${crypto.randomUUID()}`,
      payload: {
        branch,
        commitOid: headOid,
        forced: true,
        owner: link.owner,
        previousCommitOid,
        repo: link.repo,
        reset: true,
      },
    });
    return { artifactReplaced: true, branch, commitOid: headOid, previousCommitOid };
  }

  /**
   * The private-source transfer lane: clone GitHub into an in-memory fs
   * (checkout-free — a transfer only moves objects) and push to the Artifacts
   * remote. Scoped so the clone is collectable before the head-cache rebuild
   * clones again. `depth` bounds how much history inflates in this isolate.
   */
  async #transferGithubHistoryInProcess(args: {
    branch: string;
    depth?: number;
    expectedCommitOid: string;
    link: GithubRepoLink;
    token: string;
  }): Promise<void> {
    const git = await this.#cloneGithubHistoryInProcess(args);
    await this.#pushGithubHistoryInProcess({
      branch: args.branch,
      git,
      repo: await this.gitAccess(),
    });
  }

  async #cloneGithubHistoryInProcess(args: {
    branch: string;
    depth?: number;
    expectedCommitOid: string;
    link: GithubRepoLink;
    token: string;
  }): Promise<ReturnType<typeof createGit>> {
    const filesystem = new InMemoryFs();
    const git = createGit(filesystem, REPO_DIR);
    try {
      await git.clone({
        branch: args.branch,
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        noCheckout: true,
        singleBranch: true,
        url: githubRemoteUrl(args.link),
        username: "x-access-token",
        password: args.token,
      });
    } catch (error) {
      throw new Error(
        `Could not clone ${args.link.owner}/${args.link.repo}#${args.branch} from GitHub (missing branch or empty repository?): ${redactGitCredentials(String(error))}`,
      );
    }
    const [head] = await git.log({ depth: 1 });
    if (head?.oid !== args.expectedCommitOid) {
      throw new Error(
        `GitHub branch ${args.link.owner}/${args.link.repo}#${args.branch} moved during transfer (expected ${args.expectedCommitOid}, cloned ${head?.oid ?? "no head"}); retry the operation.`,
      );
    }
    return git;
  }

  async #pushGithubHistoryInProcess(args: {
    branch: string;
    git: ReturnType<typeof createGit>;
    repo: { remote: string; token: string };
  }): Promise<void> {
    // Always forced: the fast-forward decision was already made against
    // GitHub's compare API before the transfer started, and with `depth` the
    // local clone cannot prove ancestry the remote would accept anyway.
    await args.git.remote({ add: { name: "artifacts", url: args.repo.remote } });
    const pushed = await args.git.push({
      force: true,
      ref: args.branch,
      remote: "artifacts",
      username: "x",
      password: args.repo.token,
    });
    if (!pushed.ok) {
      throw new Error(
        `Pushing the adopted GitHub history to the Artifacts remote failed: ${redactGitCredentials(JSON.stringify(pushed.refs))}`,
      );
    }
  }

  #requireGithubLink(): GithubRepoLink {
    const link = this.getGithubLink();
    if (link === null) {
      throw new Error(`Repo "${this.#name.path}" is not linked to GitHub (use linkGithub first).`);
    }
    return link;
  }

  /**
   * Mint a short-lived installation token for the linked installation. Held
   * in memory for one operation only: this is first-party trusted DO code
   * (the same tier as the Secret DO's own mint strategy), and git-over-HTTPS
   * needs the token as a Basic password, which the placeholder-substitution
   * pipeline cannot produce.
   */
  async #mintGithubToken(link: GithubRepoLink): Promise<string> {
    if (this.#name.projectId === null) {
      throw new Error("GitHub-backed repos require a project-scoped repo.");
    }
    const github = parseConfig(this.env).integrations.github;
    if (!github?.appId || !github.privateKey) {
      throw new Error("GitHub App is not configured for this deployment (appId/privateKey).");
    }
    await assertGithubInstallationTokenMintAuthorized({
      installationId: link.installationId,
      privateKey: { platform: "integrations.github" },
      projectId: this.#name.projectId,
    });
    return await mintGithubInstallationToken({
      apiBase: "https://api.github.com",
      appId: github.appId,
      installationId: link.installationId,
      privateKeyPem: github.privateKey.exposeSecret(),
    });
  }

  /** The linked repository's current branch head sha, from the GitHub API. */
  async #githubBranchHead(args: {
    branch: string;
    link: GithubRepoLink;
    token: string;
  }): Promise<string> {
    const response = await this.#githubApi(
      `/repos/${args.link.owner}/${args.link.repo}/branches/${encodeURIComponent(args.branch)}`,
      args.token,
    );
    if (!response.ok) {
      throw new Error(
        `Could not read ${args.link.owner}/${args.link.repo}#${args.branch} from GitHub (missing branch or empty repository?): HTTP ${response.status}`,
      );
    }
    const data = (await response.json()) as { commit?: { sha?: string } };
    if (typeof data.commit?.sha !== "string") {
      throw new Error(
        `GitHub returned no head sha for ${args.link.owner}/${args.link.repo}#${args.branch}.`,
      );
    }
    return data.commit.sha;
  }

  /**
   * GitHub's ancestry verdict between our recorded head and the branch tip:
   * "ahead" | "identical" | "behind" | "diverged", or "unrelated" when GitHub
   * does not know the base commit (a 404 — e.g. the seeded pre-link history).
   */
  async #githubCompareStatus(args: {
    base: string;
    branch: string;
    link: GithubRepoLink;
    token: string;
  }): Promise<{ aheadBy: number; status: string }> {
    const response = await this.#githubApi(
      `/repos/${args.link.owner}/${args.link.repo}/compare/${args.base}...${encodeURIComponent(args.branch)}`,
      args.token,
    );
    if (response.status === 404) return { aheadBy: 0, status: "unrelated" };
    if (!response.ok) {
      throw new Error(
        `GitHub compare for ${args.link.owner}/${args.link.repo} failed: HTTP ${response.status}`,
      );
    }
    const data = (await response.json()) as { ahead_by?: number; status?: string };
    return {
      aheadBy: typeof data.ahead_by === "number" ? data.ahead_by : 0,
      status: typeof data.status === "string" ? data.status : "unknown",
    };
  }

  #githubApi(path: string, token: string): Promise<Response> {
    return fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "iterate-os",
      },
    });
  }

  /**
   * Best-effort mirror push after a commit. Chained onto the write chain (so
   * pushes stay ordered behind the writes they mirror) but never awaited by
   * the commit itself: a GitHub outage must not fail or slow `commitFiles`.
   * The failure fact on the repo stream is the record; the next commit's push
   * self-heals the mirror.
   */
  #scheduleGithubMirrorPush(branch: string): void {
    if (branch !== REPO_DEFAULT_BRANCH || this.getGithubLink() === null) return;
    const push = this.#serializeWrite(() => this.#pushToGithub({}));
    this.ctx.waitUntil(
      push.catch((error: unknown) => {
        console.warn("github mirror push failed (recorded on the repo stream)", error);
      }),
    );
  }

  private async importPublicGithubArtifact(input: { depth?: number; owner: string; repo: string }) {
    const artifactName = this.artifactName();
    const timing = { projectId: this.#name.projectId, path: this.#name.path };
    await timedStep("create-timing", timing, "artifact-import", async () => {
      await importGithubArtifactWithInitialPushCapture(
        this.requireArtifacts(),
        {
          branch: REPO_DEFAULT_BRANCH,
          ...(input.depth === undefined ? {} : { depth: input.depth }),
          name: artifactName,
          owner: input.owner,
          repo: input.repo,
        },
        {
          append: (event) => this.#stream.append(event),
          ensureEventSubscription: () => this.ensureArtifactRepoEventSubscription(artifactName),
          namespace: this.env.ARTIFACTS_NAMESPACE,
        },
      );
    });
    return {
      artifactName,
      defaultBranch: REPO_DEFAULT_BRANCH,
      remote: this.artifactRemote(artifactName),
    };
  }

  private async createEmptyArtifactRepo() {
    const artifactName = this.artifactName();
    const timing = { projectId: this.#name.projectId, path: this.#name.path };
    const { lastPushAt } = await timedStep("create-timing", timing, "artifact-get-or-create", () =>
      this.getOrCreateArtifact(artifactName),
    );
    const defaultBranch = REPO_DEFAULT_BRANCH;
    const remote = this.artifactRemote(artifactName);

    // A prior push is authoritative evidence that an existing Artifact is
    // already seeded. Recovery only needs to journal repos/created; cloning the
    // whole repo to rediscover that fact can exceed a Repo DO's memory limit.
    if (lastPushAt !== null) return { artifactName, defaultBranch, remote };

    const token = await timedStep("create-timing", timing, "artifact-token", () =>
      artifactToken(this.requireArtifacts(), artifactName),
    );

    const seeded = await timedStep("create-timing", timing, "artifact-seed", () =>
      seedArtifactRepo({
        branch: defaultBranch,
        files: projectRepoSeedFiles(parseConfig(this.env).iterateSdkPackageSpec),
        remote,
        token,
      }),
    );
    // `repos/created` is the creation boundary. Record the seed exactly like
    // every later push so the first read or mutation waits for an Artifacts
    // clone that can actually reach it instead of racing a stale replica.
    this.#recordPushedHead({ branch: defaultBranch, commitOid: seeded.commitOid });
    this.ctx.storage.kv.put(repoHeadStorageKey(defaultBranch), {
      commitOid: seeded.commitOid,
      contentHash: seeded.contentHash,
    });

    return {
      artifactName,
      defaultBranch,
      remote,
    };
  }

  /**
   * Clone coordinates for this repo: remote URL, a write token, and the
   * default branch. Internal (DO-to-DO) surface — the sandbox domain uses it
   * to clone the project repo into a container. It is deliberately NOT on the
   * public `Repo` capability: itx callers get file-level methods, not raw
   * artifact credentials.
   */
  // One token per isolate lifetime, not per operation: every read path
  // (getFilesSnapshot on each cold build resolve, readFile, listFiles) goes
  // through gitAccess, and minting a fresh 365-day write token per call
  // proliferates credentials for no benefit.
  #artifactTokenPromise: Promise<string> | undefined;

  async gitAccess(): Promise<{ defaultBranch: string; remote: string; token: string }> {
    const artifactName = this.artifactName();
    this.#artifactTokenPromise ??= artifactToken(this.requireArtifacts(), artifactName).catch(
      (error: unknown) => {
        this.#artifactTokenPromise = undefined;
        // A missing Artifacts repo is the pre-seed window (createArtifactRepo
        // hasn't run), the same "not ready yet" every unseeded clone signals.
        throw classifyRepoAccessError(error);
      },
    );
    return {
      defaultBranch: REPO_DEFAULT_BRANCH,
      remote: this.artifactRemote(artifactName),
      token: await this.#artifactTokenPromise,
    };
  }

  private async getOrCreateArtifact(
    name: string,
  ): Promise<{ created: boolean; lastPushAt: string | null }> {
    return await getOrCreateArtifact(this.requireArtifacts(), name, {
      beforeFirstPush: () => this.ensureArtifactRepoEventSubscription(name),
      defaultBranch: REPO_DEFAULT_BRANCH,
    });
  }

  private async ensureArtifactRepoEventSubscription(repoName: string): Promise<void> {
    if (this.env.DEPLOYMENT_ENV === undefined) return;
    const apiToken = this.env.APP_CONFIG_CLOUDFLARE__API_TOKEN?.trim();
    if (!apiToken) {
      throw new Error(
        `Deployment ${this.env.DEPLOYMENT_ENV} cannot subscribe Artifacts repo events without APP_CONFIG_CLOUDFLARE__API_TOKEN`,
      );
    }
    const api = createCloudflareAccountApi({
      accountId: this.env.ARTIFACTS_ACCOUNT_ID,
      apiToken,
    });
    await ensureArtifactRepoEventSubscriptionForWorker(api, {
      repoName,
      workerName: this.env.WORKER_SELF,
    });
  }

  private requireArtifacts(): Artifacts {
    return this.env.ARTIFACTS;
  }

  private artifactName() {
    return RepoArtifactNameCodec.stringify({
      path: this.#name.path,
      projectId: this.#name.projectId,
    });
  }

  private artifactRemote(artifactName: string) {
    return `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.ARTIFACTS_NAMESPACE}/${artifactName}.git`;
  }
}

async function artifactToken(artifacts: Artifacts, name: string) {
  const repo = await artifacts.get(name);
  const { plaintext } = await repo.createToken("write", REPO_WRITE_TOKEN_TTL_SECONDS);
  return plaintext.split("?expires=")[0] ?? plaintext;
}

async function seedArtifactRepo(input: {
  branch: string;
  files: Array<{ content: string; path: string }>;
  remote: string;
  token: string;
}): Promise<{ commitOid: string; contentHash: string }> {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = { password: input.token, username: "x" };

  let cloned = false;
  try {
    await git.clone({
      branch: input.branch,
      depth: 1,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
    cloned = true;
  } catch {
    await git.init({ defaultBranch: input.branch });
    await git.remote({
      add: { name: "origin", url: input.remote },
    });
  }

  // Creation is create-if-absent, never reset-to-template. In particular, a
  // create-succeeded/ready-append-failed retry must preserve every commit that
  // may have landed since the first drive.
  if (cloned) {
    const [head] = await git.log({ depth: 1, ref: input.branch }).catch((error: unknown) => {
      if (isRepoNotSeededError(classifyRepoAccessError(error, input.branch))) return [];
      throw error;
    });
    if (head) {
      return {
        commitOid: head.oid,
        contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
      };
    }
  }

  for (const file of input.files) {
    const dir = `${REPO_DIR}/${file.path}`.replace(/\/[^/]+$/, "");
    if (dir !== REPO_DIR && !(await filesystem.exists(dir))) {
      await filesystem.mkdir(dir, { recursive: true });
    }
    await filesystem.writeFile(`${REPO_DIR}/${file.path}`, file.content);
    await git.add({ filepath: file.path });
  }

  const identity = {
    email: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email,
    name: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name,
    timestamp: REPO_SEED_COMMIT_TIMESTAMP_SECONDS,
    timezoneOffset: 0,
  };
  await git.commit({
    author: identity,
    message: "Seed minimal itx project worker",
  });
  await ensureBranchRef({ branch: input.branch, git });

  // When two first drives both observe an empty remote, the fixed
  // identity/timestamp above gives them the same root oid. Never force this
  // publication: if a different branch head appeared, creation must lose the
  // race instead of replacing real history.
  const pushed = await git.push({
    ref: input.branch,
    remote: "origin",
    ...credentials,
  });
  if (!pushed.ok) {
    throw new Error(`Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`);
  }

  const [head] = await git.log({ depth: 1, ref: input.branch });
  if (!head) throw new Error(`Seeded repo has no head commit on ${input.branch}.`);
  return {
    commitOid: head.oid,
    contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
  };
}

async function commitFilesToArtifactRepo(input: {
  author?: { email: string; name: string };
  branch: string;
  changes: RepoFileChange[];
  expectedCommitOid?: string;
  message: string;
  remote: string;
  token: string;
}): Promise<CommitRepoFilesResult & { contentHash: string; parentCommitOid: string }> {
  return mutateArtifactRepo({
    author: input.author,
    branch: input.branch,
    expectedCommitOid: input.expectedCommitOid,
    message: input.message,
    remote: input.remote,
    token: input.token,
    mutate: async ({ filesystem, git }) => {
      for (const change of input.changes) {
        const path = normalizeRepoFilePath(change.path);
        const absolutePath = `${REPO_DIR}/${path}`;

        if ("delete" in change) {
          if (await filesystem.exists(absolutePath)) await filesystem.rm(absolutePath);
          await git.rm({ filepath: path });
          continue;
        }

        const dir = absolutePath.replace(/\/[^/]+$/, "");
        if (dir !== REPO_DIR && !(await filesystem.exists(dir))) {
          await filesystem.mkdir(dir, { recursive: true });
        }
        if ("contentBase64" in change) {
          await filesystem.writeFileBytes(absolutePath, base64ToBytes(change.contentBase64));
        } else {
          await filesystem.writeFile(absolutePath, change.content);
        }
        await git.add({ filepath: path });
      }
      return {};
    },
  });
}

async function editArtifactRepoFile(input: {
  author?: { email: string; name: string };
  branch: string;
  expectedCommitOid?: string;
  message: string;
  newString: string;
  oldString: string;
  path: string;
  remote: string;
  replaceAll?: boolean;
  token: string;
}): Promise<EditRepoFileResult & { contentHash: string; parentCommitOid: string }> {
  return mutateArtifactRepo({
    author: input.author,
    branch: input.branch,
    expectedCommitOid: input.expectedCommitOid,
    message: input.message,
    remote: input.remote,
    token: input.token,
    mutate: async ({ filesystem, git }) => {
      const absolutePath = `${REPO_DIR}/${input.path}`;
      if (!(await filesystem.exists(absolutePath))) {
        throw new Error(`Repo file does not exist: "${input.path}".`);
      }

      const content = await filesystem.readFile(absolutePath);
      const occurrenceCount = countOccurrences(content, input.oldString);
      if (occurrenceCount === 0) {
        throw new Error(`Edit oldString was not found in "${input.path}".`);
      }
      if (!input.replaceAll && occurrenceCount !== 1) {
        throw new Error(
          `Edit oldString matched ${occurrenceCount} times in "${input.path}"; pass replaceAll to replace every occurrence.`,
        );
      }

      const edited = replaceLiteralOccurrences({
        content,
        newString: input.newString,
        oldString: input.oldString,
      });
      await filesystem.writeFile(absolutePath, edited);
      await git.add({ filepath: input.path });

      return { occurrenceCount, path: input.path };
    },
  });
}

async function mutateArtifactRepo<Extra extends Record<string, unknown>>(input: {
  author?: { email: string; name: string };
  branch: string;
  expectedCommitOid?: string;
  message: string;
  mutate: (repo: { filesystem: InMemoryFs; git: ReturnType<typeof createGit> }) => Promise<Extra>;
  remote: string;
  token: string;
}): Promise<CommitRepoFilesResult & { contentHash: string; parentCommitOid: string } & Extra> {
  const credentials = { password: input.token, username: "x" };
  const clone = async () => {
    const filesystem = new InMemoryFs();
    const git = createGit(filesystem, REPO_DIR);
    let head: { oid: string } | undefined;
    try {
      await git.clone({
        branch: input.branch,
        singleBranch: true,
        url: input.remote,
        ...credentials,
      });
      [head] = await git.log({ depth: 1, ref: input.branch });
    } catch (error) {
      throw classifyRepoAccessError(error, input.branch);
    }
    if (!head) throw new RepoNotSeededError("Repo has no commits.");
    return { filesystem, git, head };
  };

  let cloned: Awaited<ReturnType<typeof clone>> | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      cloned = await clone();
      if (
        input.expectedCommitOid === undefined ||
        cloned.head.oid === input.expectedCommitOid ||
        (await gitBranchContainsCommit({
          branch: input.branch,
          commitOid: input.expectedCommitOid,
          git: cloned.git,
        }))
      ) {
        break;
      }
      if (attempt >= ARTIFACT_HEAD_VISIBILITY_RETRIES) {
        throw new Error(
          `Artifact branch ${input.branch} did not contain the last pushed commit ${input.expectedCommitOid} (saw ${cloned.head.oid}); refusing to commit on a stale or diverged base.`,
        );
      }
      console.warn(
        `repo mutation clone does not contain the last push (saw ${cloned.head.oid}, pushed ${input.expectedCommitOid}); retry ${attempt + 1}`,
      );
    } catch (error) {
      if (input.expectedCommitOid === undefined || attempt >= ARTIFACT_HEAD_VISIBILITY_RETRIES) {
        throw error;
      }
      console.warn(
        `repo mutation clone could not reach the last pushed commit ${input.expectedCommitOid}; retry ${attempt + 1}: ${String(error)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }

  const { filesystem, git } = cloned;

  const extra = await input.mutate({ filesystem, git });
  const changedPaths = (await git.status()).map((entry) => entry.filepath).sort();
  if (changedPaths.length === 0) {
    const [head] = await git.log({ depth: 1 });
    if (!head) throw new Error("Repo has no commits.");
    return {
      branch: input.branch,
      changedPaths,
      commitOid: head.oid,
      contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
      noChanges: true,
      parentCommitOid: cloned.head.oid,
      ...extra,
    };
  }

  const commit = await git.commit({
    author: input.author ?? {
      email: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email,
      name: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name,
    },
    message: input.message,
  });
  // No force: writes are serialized by the DO's #writeChain, and the clone
  // above contains our last pushed commit, so one commit is a fast-forward.
  // A rejection now means an out-of-band writer moved the ref after that
  // checked clone and should fail loudly, not clobber.
  const pushed = await git.push({
    ref: input.branch,
    remote: "origin",
    ...credentials,
  });
  if (!pushed.ok) {
    throw new Error(`Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`);
  }

  return {
    branch: input.branch,
    changedPaths,
    commitOid: commit.oid,
    contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
    noChanges: false,
    // The checked clone's pre-commit head — the commit's TRUE parent, which
    // the head authority needs to prune that tip from the observed frontier.
    parentCommitOid: cloned.head.oid,
    ...extra,
  };
}

function repoHeadStorageKey(branch: string) {
  // The value is "latest head at this branch" ({ commitOid, contentHash }),
  // not immutable history — exactly the late-bound pointer branch-backed
  // worker file sources resolve through before pinning a build. The version
  // segment makes a contentHash recipe change a clean cache flush instead of
  // old and new hashes silently mixing in build keys.
  return `repo-head:v1:${branch}`;
}

function repoPushedHeadStorageKey(branch: string) {
  return `repo-pushed-head:${branch}`;
}

/** The branch's observed push window — `(before, after)` pairs whose frontier
 * is the set of cacheable resolutions ({@link decideHeadResolution}). */
function repoObservedPushesStorageKey(branch: string): string {
  return `repo-observed-push:${branch}`;
}

/** The git-over-HTTPS remote of a linked GitHub repository. */
function githubRemoteUrl(link: { owner: string; repo: string }): string {
  return `https://github.com/${link.owner}/${link.repo}.git`;
}

/**
 * Strip git credentials from strings surfaced to callers. Both git-over-HTTPS
 * URLs (`x-access-token:<token>@`) and bare installation tokens can leak
 * through third-party error messages — the Artifacts service has been
 * observed echoing a credentialed source URL verbatim in import errors.
 */
function redactGitCredentials(text: string): string {
  return text
    .replace(/\/\/[^/@\s]+@/g, "//***@")
    .replace(/gh[a-z]_[A-Za-z0-9_]+/g, "gh*_***")
    .replace(/art_v1_[A-Za-z0-9?=]+/g, "art_v1_***");
}

function isGithubLinkRecord(value: unknown): value is GithubRepoLink {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<GithubRepoLink>;
  return (
    typeof record.connection === "string" &&
    typeof record.installationId === "string" &&
    typeof record.owner === "string" &&
    typeof record.repo === "string" &&
    typeof record.repositoryId === "number" &&
    Number.isSafeInteger(record.repositoryId) &&
    record.repositoryId > 0
  );
}

function isRepoHeadRecord(value: unknown): value is { commitOid: string; contentHash: string } {
  if (value === null || typeof value !== "object") return false;
  const record = value as { commitOid?: unknown; contentHash?: unknown };
  return (
    typeof record.commitOid === "string" &&
    record.commitOid.length > 0 &&
    typeof record.contentHash === "string" &&
    record.contentHash.length > 0
  );
}

/** The public `RepoLogCommit` projection of a git log entry: epoch-ms
 * timestamp (git speaks seconds), trailing-newline-trimmed message. */
function toRepoLogCommit(entry: GitLogEntry): RepoLogCommit {
  return {
    author: { email: entry.author.email, name: entry.author.name },
    message: entry.message.replace(/\n+$/, ""),
    oid: entry.oid,
    parents: entry.parent,
    timestamp: entry.author.timestamp * 1000,
  };
}

const REPO_LOG_DEFAULT_LIMIT = 20;
const REPO_LOG_MAX_LIMIT = 200;

function assertGithubHistoryDepth(depth: number | undefined, method: string): void {
  if (depth !== undefined && (!Number.isInteger(depth) || depth <= 0)) {
    throw new Error(`${method} depth must be a positive integer.`);
  }
}

function parseLogLimit(limit: number | undefined): number {
  if (limit === undefined) return REPO_LOG_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > REPO_LOG_MAX_LIMIT) {
    throw new Error(`log limit must be an integer between 1 and ${REPO_LOG_MAX_LIMIT}.`);
  }
  return limit;
}

/** Commit oids are full 40-hex sha1 strings — never abbreviated refs, so a
 * pinned read can't silently resolve a branch or tag name. */
function assertCommitOid(commitOid: string): void {
  if (!/^[0-9a-f]{40}$/.test(commitOid)) {
    throw new Error(`commitOid must be a full 40-character hex sha, got "${commitOid}".`);
  }
}

function parseCommitFilesInput(input: CommitRepoFilesInput): CommitRepoFilesInput {
  if (!input || typeof input !== "object") throw new Error("commitFiles input is required.");
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("commitFiles message must be a non-empty string.");
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new Error("commitFiles changes must be a non-empty array.");
  }
  if (
    input.branch !== undefined &&
    (typeof input.branch !== "string" || input.branch.trim() === "")
  ) {
    throw new Error("commitFiles branch must be a non-empty string.");
  }
  if (input.author !== undefined) {
    if (
      typeof input.author.name !== "string" ||
      input.author.name.trim() === "" ||
      typeof input.author.email !== "string" ||
      input.author.email.trim() === ""
    ) {
      throw new Error("commitFiles author must include non-empty name and email.");
    }
  }

  return {
    ...input,
    branch: input.branch?.trim(),
    changes: input.changes.map((change) => {
      const path = normalizeRepoFilePath(change.path);
      if ("delete" in change) return { delete: true, path };
      if ("contentBase64" in change) {
        if (typeof change.contentBase64 !== "string") {
          throw new Error(`commitFiles change "${path}" contentBase64 must be a string.`);
        }
        return { contentBase64: change.contentBase64, path };
      }
      if (typeof change.content !== "string") {
        throw new Error(`commitFiles change "${path}" content must be a string.`);
      }
      return { content: change.content, path };
    }),
    message: input.message.trim(),
  };
}

function parseEditRepoFileInput(input: EditRepoFileInput): EditRepoFileInput {
  if (!input || typeof input !== "object") throw new Error("edit input is required.");
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("edit message must be a non-empty string.");
  }
  if (
    input.branch !== undefined &&
    (typeof input.branch !== "string" || input.branch.trim() === "")
  ) {
    throw new Error("edit branch must be a non-empty string.");
  }
  if (input.author !== undefined) {
    if (
      typeof input.author.name !== "string" ||
      input.author.name.trim() === "" ||
      typeof input.author.email !== "string" ||
      input.author.email.trim() === ""
    ) {
      throw new Error("edit author must include non-empty name and email.");
    }
  }
  if (typeof input.oldString !== "string" || input.oldString === "") {
    throw new Error("edit oldString must be a non-empty string.");
  }
  if (typeof input.newString !== "string") {
    throw new Error("edit newString must be a string.");
  }
  if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") {
    throw new Error("edit replaceAll must be a boolean.");
  }

  return {
    ...input,
    branch: input.branch?.trim(),
    message: input.message.trim(),
    path: normalizeRepoFilePath(input.path),
  };
}

function normalizeRepoFilePath(path: string): string {
  if (typeof path !== "string") throw new Error("Repo file path must be a string.");
  const normalized = path.trim().replace(/^\/+/, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("/./") ||
    normalized.startsWith(".git/")
  ) {
    throw new Error(`Invalid repo file path: "${path}".`);
  }
  return normalized;
}

async function ensureBranchRef(input: { branch: string; git: ReturnType<typeof createGit> }) {
  try {
    await input.git.branch({ name: input.branch });
  } catch (error) {
    if (!String(error).match(/already exists/i)) throw error;
  }
}
