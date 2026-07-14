import { DurableObject } from "cloudflare:workers";
import { InMemoryFs } from "@cloudflare/shell";
import { createGit, type GitLogEntry } from "@cloudflare/shell/git";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { LiveStateRpcTarget, StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { filterWorkerSnapshotPaths } from "../workers/source-masks.ts";
import { stableSha256 } from "../workers/utils.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { parseConfig } from "../../config.ts";
import {
  assertGithubInstallationTokenMintAuthorized,
  mintGithubInstallationToken,
} from "../integrations/github-app.ts";
import { ITERATE_GITHUB_BOT_COMMIT_AUTHOR } from "../integrations/utils.ts";
import {
  indexRepoSnapshotToSearchIndex,
  triggerProjectSearchSyncDebounced,
} from "../search/search-index.ts";
import { ROOT_WORKSPACE_PATH } from "../workspaces/utils.ts";
import type {
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  EditRepoFileInput,
  EditRepoFileResult,
  GithubRepoLink,
  GithubSyncResult,
  RepoCommitDetails,
  RepoFileChange,
  RepoLogCommit,
  RepoLogResult,
} from "./types.ts";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import { diffFileMaps } from "./line-diff.ts";
import {
  CONFIG_REPO_PATH,
  RepoArtifactNameCodec,
  RepoNotSeededError,
  base64ToBytes,
  bytesToBase64,
  classifyRepoAccessError,
} from "./utils.ts";
import { projectRepoSeedFiles } from "./project-repo-seed.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { diffRepoTaskFiles, type RepoCommittedFileChange } from "./repo-task-events.ts";

const REPO_DEFAULT_BRANCH = "main";

// Sentinel for "the root workspace cache could not answer — use the clone
// lane". Distinct from null, which is an authoritative "not at HEAD".
const CACHE_UNAVAILABLE = Symbol("cache-unavailable");
const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
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

type RepoHead = {
  branch: string;
  commitOid: string;
  contentHash: string;
};

export class RepoDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });
  readonly #host = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  readonly #repoProcessor = this.#host.add(
    (deps) =>
      new RepoProcessor({
        ...deps,
        createRepoArtifact: (input) => this.createArtifactRepo(input),
        taskChangesForArtifactPush: (input) => this.#taskChangesForArtifactPush(input),
      }),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#host.wakeStreamSubscriber(args);
  }

  /** The keepalive's revival alarm — see stream-processor-host.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#host.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#repoProcessor);
  }

  /** The repo's live state — the get/set/assign/subscribe surface behind `itx.repos.get(path).liveState`. */
  get liveState() {
    return new LiveStateRpcTarget(this.#host);
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
    // Same staleness rule against the recorded push: a checkout that lags the
    // last pushed head (snapshot retries exhausted, or a syncFromGithub moved
    // the branch while this clone was in flight) may be SERVED once, but must
    // never be CACHED — an un-invalidatable cache entry would pin builds to
    // the pre-sync head forever.
    const pushed = this.ctx.storage.kv.get<string>(`repo-pushed-head:${branch}`);
    if (typeof pushed === "string" && pushed !== head.commitOid) return { branch, ...head };
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
    const { filesystem, head } = await this.#checkout(input);

    // Mask paths BEFORE reading contents: an excluded tree (a committed
    // node_modules/, build output) should cost a directory walk, not reads.
    const paths = await walkCheckoutPaths(filesystem);
    const selected = filterWorkerSnapshotPaths(paths.sort(), {
      exclude: input.exclude,
      include: input.include,
    });
    const files: Record<string, string> = {};
    for (const path of selected) {
      files[path] = await filesystem.readFile(`${REPO_DIR}/${path}`);
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
    // has the full story). BOTH paths retry against the recorded push — a
    // pinned read of a just-pushed commit (the History diff pane's flow:
    // commit → expand → click a file) fails its checkout on a stale clone for
    // exactly the same reason a branch read serves the previous head.
    const expected = this.ctx.storage.kv.get<string>(`repo-pushed-head:${branch}`);

    if (input.commitOid !== undefined) {
      for (let attempt = 1; ; attempt++) {
        // Pinned commits need history: a shallow clone only contains the
        // branch tip. Project repos are small; correctness beats depth tuning.
        const filesystem = new InMemoryFs();
        const git = createGit(filesystem, REPO_DIR);
        try {
          await git.clone({ branch, url: repo.remote, ...credentials });
        } catch (error) {
          throw classifyRepoAccessError(error);
        }
        const [branchHead] = await git.log({ depth: 1 });
        if (!branchHead) throw new RepoNotSeededError("Repo has no commits.");
        try {
          await git.checkout({ ref: input.commitOid, force: true });
        } catch (error) {
          // A clone still BEHIND the recorded push may simply predate the
          // pinned commit — retryable. A caught-up clone that lacks the oid
          // means the oid genuinely is not on this branch: fail fast.
          if (expected && branchHead.oid !== expected && attempt <= 5) {
            console.warn(
              `repo pinned clone is behind the last push (saw ${branchHead.oid}, pushed ${expected}); retry ${attempt} for ${input.commitOid}`,
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
      try {
        await git.clone({
          branch,
          ...(input.historyDepth === "full" ? {} : { depth: input.historyDepth || 1 }),
          singleBranch: true,
          url: repo.remote,
          ...credentials,
        });
      } catch (error) {
        throw classifyRepoAccessError(error);
      }
      const [head] = await git.log({ depth: 1 });
      if (!head) throw new RepoNotSeededError("Repo has no commits.");
      return { filesystem, git, head };
    };

    let { filesystem, git, head } = await clone();
    for (let attempt = 1; expected && head.oid !== expected && attempt <= 5; attempt++) {
      console.warn(
        `repo clone is behind the last push (saw ${head.oid}, pushed ${expected}); retry ${attempt}`,
      );
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
  // is exactly what makes a local chain a sufficient lock.
  #writeChain: Promise<unknown> = Promise.resolve();

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
    const result = await commitFilesToArtifactRepo({
      author: parsed.author,
      branch: parsed.branch ?? repo.defaultBranch,
      changes: parsed.changes,
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
      this.#scheduleSearchIndex(result.branch);
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
    const result = await editArtifactRepoFile({
      author: parsed.author,
      branch: parsed.branch ?? repo.defaultBranch,
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
      this.#scheduleSearchIndex(result.branch);
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
  #recordPushedHead(result: { branch: string; commitOid: string; noChanges?: boolean }) {
    if (result.noChanges) return;
    this.ctx.storage.kv.put(`repo-pushed-head:${result.branch}`, result.commitOid);
  }

  /**
   * Committed file contents at HEAD — or, with `commitOid`, pinned to that
   * commit — null when the path does not exist there. `encoding: "base64"`
   * reads the raw bytes (images, PDFs — anything a utf8 decode would corrupt)
   * and returns them base64-encoded. HEAD reads serve from the root workspace
   * cache (no clone); pinned reads keep the clone lane (the cache only ever
   * holds the head).
   */
  async readFile(input: {
    path: string;
    encoding?: "utf8" | "base64";
    commitOid?: string;
  }): Promise<{ commitOid: string; content: string; path: string } | null> {
    const path = normalizeRepoFilePath(input.path);
    if (input.commitOid !== undefined) assertCommitOid(input.commitOid);
    if (input.commitOid === undefined) {
      const cached = await this.#readHeadFromRootCache(path, input.encoding);
      if (cached !== CACHE_UNAVAILABLE) return cached;
    }
    if (input.encoding === "base64") {
      const { filesystem, head } = await this.#checkout({ commitOid: input.commitOid });
      const absolutePath = `${REPO_DIR}/${path}`;
      if (!(await filesystem.exists(absolutePath))) return null;
      const bytes = await filesystem.readFileBytes(absolutePath);
      return { commitOid: head.oid, content: bytesToBase64(bytes), path };
    }
    // Exact map lookup, deliberately not an include mask: glob metacharacters
    // in a filename must not change what this reads.
    const { commitOid, files } = await this.getFilesSnapshot({ commitOid: input.commitOid });
    const content = files[path];
    return content === undefined ? null : { commitOid, content, path };
  }

  /** All committed file paths at HEAD (the project repo serves from the root workspace cache). */
  async listFiles(): Promise<{ commitOid: string; paths: string[] }> {
    if (this.#hasRootWorkspaceCache()) {
      try {
        const head = await this.getHead();
        const paths = await this.#rootWorkspaceStub().listAllFiles();
        return { commitOid: head.commitOid, paths: paths.map((p) => p.slice(1)).sort() };
      } catch (error) {
        console.warn(
          `repo listFiles via the root workspace cache failed; falling back to a clone: ${String(error)}`,
        );
      }
    }
    const { commitOid, files } = await this.getFilesSnapshot();
    return { commitOid, paths: Object.keys(files).sort() };
  }

  /**
   * A HEAD file read served from the project's root workspace — the durable
   * cache of main this repo already keeps fresh through its head cursor —
   * instead of a full clone per read.
   *
   * Call order matters: `getHead()` FIRST warms this DO's durable head cursor
   * (the one-time cold miss clones), so when the root workspace's freshness
   * check dials back into this DO re-entrantly (we are awaiting its read at
   * that moment; the input gate is open at RPC awaits), that nested
   * `getHead()` is a synchronous kv hit. The returned oid is the cursor read
   * before the content — a commit landing between the two can make the
   * content newer than its label, the inherent approximation of a HEAD read.
   *
   * The cache is a CACHE: any failure (workspace DO unhappy, uncacheable
   * repo) falls back to the authoritative clone lane, loudly.
   */
  async #readHeadFromRootCache(
    path: string,
    encoding: "utf8" | "base64" | undefined,
  ): Promise<
    { commitOid: string; content: string; path: string } | null | typeof CACHE_UNAVAILABLE
  > {
    if (!this.#hasRootWorkspaceCache()) return CACHE_UNAVAILABLE;
    try {
      const head = await this.getHead();
      const root = this.#rootWorkspaceStub();
      if (encoding === "base64") {
        const bytes = await root.readFileBytes(`/${path}`);
        return bytes === null
          ? null
          : { commitOid: head.commitOid, content: bytesToBase64(bytes), path };
      }
      const content = await root.readFile(`/${path}`);
      return content === null ? null : { commitOid: head.commitOid, content, path };
    } catch (error) {
      console.warn(
        `repo head read via the root workspace cache failed; falling back to a clone: ${String(error)}`,
      );
      return CACHE_UNAVAILABLE;
    }
  }

  // The root workspace mirrors exactly ONE repo: the project repo at "/".
  // Every other repo (secondary /repos/**, per-example scratch repos,
  // projectId-less legacy repos) stays on the clone lane — serving them from
  // the project root's checkout returns the WRONG repo's files.
  #hasRootWorkspaceCache(): boolean {
    return this.#name.projectId !== null && this.#name.path === CONFIG_REPO_PATH;
  }

  #rootWorkspaceStub() {
    return this.env.WORKSPACE.getByName(
      DurableObjectNameCodec.stringify({
        path: ROOT_WORKSPACE_PATH,
        projectId: this.#name.projectId!,
      }),
    );
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
    const commitFiles = await readCheckoutBytes(filesystem);
    let parentFiles = new Map<string, Uint8Array>();
    if (parentOid !== null) {
      await git.checkout({ ref: parentOid, force: true });
      parentFiles = await readCheckoutBytes(filesystem);
    }

    return { ...toRepoLogCommit(entry), files: diffFileMaps(parentFiles, commitFiles), parentOid };
  }

  // ===========================================================================
  // GitHub mirror: an optional linked GitHub repository this repo pushes to.
  //
  // The Artifacts repo stays primary — commits succeed against it regardless
  // of GitHub's availability — and the linked GitHub repo is a mirror kept
  // fresh by a best-effort push after every commit. git push is cumulative, so
  // a failed mirror push self-heals on the next commit; `pushToGithub` repairs
  // on demand. `syncFromGithub` is the explicit reverse lane: adopt GitHub's
  // branch head, fast-forward only unless forced.
  // ===========================================================================

  /** The current GitHub link, or null when this repo is not linked. */
  getGithubLink(): GithubRepoLink | null {
    const stored = this.ctx.storage.kv.get<unknown>(GITHUB_LINK_KV_KEY);
    return isGithubLinkRecord(stored) ? stored : null;
  }

  // In both link verbs the journal append comes FIRST and the KV write last:
  // the append is the only step that can fail (it crosses to the Stream DO),
  // while the synchronous KV write inside this DO cannot, so ordering them
  // this way means a failure changes nothing and the caller can just retry —
  // the journal and the KV projection never diverge.

  /** Record the GitHub link durably and journal the fact on the repo stream. */
  async configureGithubLink(link: GithubRepoLink): Promise<GithubRepoLink> {
    await this.#host.stream.appendAck({
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
    await this.#host.stream.appendAck({
      type: "events.iterate.com/repo/github-unlinked",
      payload: { connection: link.connection, owner: link.owner, repo: link.repo },
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

      await this.#host.stream.appendAck({
        type: "events.iterate.com/repo/github-push-completed",
        idempotencyKey: `github-push-completed:${link.owner}/${link.repo}:${head.oid}`,
        payload: { branch, commitOid: head.oid, owner: link.owner, repo: link.repo },
      });
      return { branch, commitOid: head.oid };
    } catch (error) {
      await this.#host.stream
        .appendAck({
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
   * force-push to the Artifacts remote), so big histories need `depth` —
   * which prunes the adopted history to the newest N commits. GitHub retains
   * the full history, so nothing is lost and a later deeper sync can widen
   * the window.
   */
  syncFromGithub(input: { depth?: number; force?: boolean } = {}): Promise<GithubSyncResult> {
    return this.#serializeWrite(() => this.#syncFromGithub(input));
  }

  async #syncFromGithub(input: { depth?: number; force?: boolean }): Promise<GithubSyncResult> {
    const link = this.#requireGithubLink();
    const branch = REPO_DEFAULT_BRANCH;
    const previous = this.ctx.storage.kv.get<unknown>(repoHeadStorageKey(branch));
    const previousCommitOid = isRepoHeadRecord(previous) ? previous.commitOid : null;
    if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth <= 0)) {
      throw new Error("syncFromGithub depth must be a positive integer.");
    }
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
    if (input.force !== true) {
      const status =
        previousCommitOid === null
          ? "unrelated"
          : await this.#githubCompareStatus({ base: previousCommitOid, branch, link, token });
      if (status !== "ahead") {
        throw new Error(
          `syncFromGithub is not a fast-forward (GitHub says "${status}" relative to this repo's head ${previousCommitOid ?? "(none)"}). Pass force: true to discard local-only history and adopt GitHub's head.`,
        );
      }
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
    await this.#transferGithubHistoryInProcess({ branch, depth: input.depth, link, token });

    // The adopted head is recorded for read-your-write, then the head cache
    // is invalidated and rebuilt through getHead's own cold-miss path (a
    // shallow depth-1 clone — head-snapshot-sized even for big repos).
    // Ordering matters: with the pushed head recorded first, getHead's
    // lags-the-push guard keeps any concurrently in-flight pre-sync checkout
    // from repopulating the cache with the old head.
    this.#recordPushedHead({ branch, commitOid: headOid });
    this.ctx.storage.kv.delete(repoHeadStorageKey(branch));
    await this.getHead({ branch });

    await this.#host.stream.appendAck({
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
    this.#scheduleSearchIndex(branch);
    return {
      branch,
      changed: true,
      commitOid: headOid,
      forced: input.force === true,
      previousCommitOid,
    };
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
    link: GithubRepoLink;
    token: string;
  }): Promise<void> {
    const repo = await this.gitAccess();
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
    // Always forced: the fast-forward decision was already made against
    // GitHub's compare API before the transfer started, and with `depth` the
    // local clone cannot prove ancestry the remote would accept anyway.
    await git.remote({ add: { name: "artifacts", url: repo.remote } });
    const pushed = await git.push({
      force: true,
      ref: args.branch,
      remote: "artifacts",
      username: "x",
      password: repo.token,
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
  }): Promise<string> {
    const response = await this.#githubApi(
      `/repos/${args.link.owner}/${args.link.repo}/compare/${args.base}...${encodeURIComponent(args.branch)}`,
      args.token,
    );
    if (response.status === 404) return "unrelated";
    if (!response.ok) {
      throw new Error(
        `GitHub compare for ${args.link.owner}/${args.link.repo} failed: HTTP ${response.status}`,
      );
    }
    const data = (await response.json()) as { status?: string };
    return typeof data.status === "string" ? data.status : "unknown";
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

  /**
   * SPIKE: re-index this repo's HEAD into the itx.search corpus NOW, and
   * return the sweep/write counts. The public entry point behind
   * `itx.search.indexRepo` — a manual backfill/repair.
   *
   * Serialized on `#serializeWrite`: a snapshot reads HEAD and runs a
   * stale-key sweep, so a manual reindex that overlapped a post-commit index
   * (or another manual one) and finished out of order could let an older
   * sweep delete objects a newer snapshot wrote. Running on the same write
   * chain as commits and `#scheduleSearchIndex` makes the last-committed
   * snapshot the last to run, so the corpus converges on current HEAD.
   */
  reindexSearch(): Promise<{ deleted: number; indexed: number; skipped: number; failed: number }> {
    const projectId = this.#name.projectId;
    if (projectId === null) {
      throw new Error("search indexing requires a project-scoped repo");
    }
    return this.#serializeWrite(async () => {
      const snapshot = await this.getFilesSnapshot({ branch: REPO_DEFAULT_BRANCH });
      return indexRepoSnapshotToSearchIndex({
        files: snapshot.files,
        projectId,
        repoPath: this.#name.path,
      });
    });
  }

  /**
   * SPIKE: best-effort re-index of this repo's default-branch HEAD into the
   * itx.search corpus after a write lands. Same never-fail-the-write posture
   * as the GitHub mirror push; a failure just leaves the index one commit
   * stale until the next write (or an explicit `itx.search.indexRepo`).
   * Shares the serialized `reindexSearch` path so post-commit and manual
   * reindexes can never race each other's stale-key sweeps.
   */
  #scheduleSearchIndex(branch: string): void {
    const projectId = this.#name.projectId;
    if (branch !== REPO_DEFAULT_BRANCH || projectId === null) return;
    this.ctx.waitUntil(
      this.reindexSearch()
        // Freshness: nudge the project's instance (if one exists) so the new
        // snapshot is searchable in minutes, not on the hourly schedule.
        .then(() => triggerProjectSearchSyncDebounced(projectId))
        .catch((error: unknown) => {
          console.warn("search index repo snapshot failed", error);
        }),
    );
  }

  private async createArtifactRepo(_input: { path: string; projectId: string | null }) {
    const artifactName = this.artifactName();
    const timing = { projectId: this.#name.projectId, path: this.#name.path };
    await timedStep("create-timing", timing, "artifact-get-or-create", () =>
      this.getOrCreateArtifact(artifactName),
    );
    const defaultBranch = REPO_DEFAULT_BRANCH;
    const remote = this.artifactRemote(artifactName);
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

  private async getOrCreateArtifact(name: string): Promise<{ created: boolean }> {
    try {
      await this.requireArtifacts().create(name, {
        setDefaultBranch: REPO_DEFAULT_BRANCH,
      });
      return { created: true };
    } catch (error) {
      // Only the race we mean to tolerate. The old blind catch masked real
      // failures (an INTERNAL_ERROR here fell through to get(), which then
      // reported a misleading NOT_FOUND).
      if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
      await this.requireArtifacts().get(name);
      return { created: false };
    }
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

  try {
    await git.clone({
      branch: input.branch,
      depth: 1,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
  } catch {
    await git.init({ defaultBranch: input.branch });
    await git.remote({
      add: { name: "origin", url: input.remote },
    });
  }

  for (const file of input.files) {
    const dir = `${REPO_DIR}/${file.path}`.replace(/\/[^/]+$/, "");
    if (dir !== REPO_DIR && !(await filesystem.exists(dir))) {
      await filesystem.mkdir(dir, { recursive: true });
    }
    await filesystem.writeFile(`${REPO_DIR}/${file.path}`, file.content);
    await git.add({ filepath: file.path });
  }

  try {
    await git.commit({
      author: {
        email: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email,
        name: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name,
      },
      message: "Seed minimal itx project worker",
    });
    await ensureBranchRef({ branch: input.branch, git });
  } catch (error) {
    if (!String(error).match(/nothing to commit|no changes/i)) throw error;
  }

  const pushed = await git.push({
    force: true,
    ref: input.branch,
    remote: "origin",
    ...credentials,
  });
  if (!pushed.ok) {
    throw new Error(`Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`);
  }

  const [head] = await git.log({ depth: 1 });
  if (!head) throw new Error(`Seeded repo has no head commit on ${input.branch}.`);
  return {
    commitOid: head.oid,
    contentHash: await repoContentHash(await readCheckoutFiles(filesystem)),
  };
}

async function commitFilesToArtifactRepo(input: {
  author?: { email: string; name: string };
  branch: string;
  changes: RepoFileChange[];
  message: string;
  remote: string;
  token: string;
}): Promise<CommitRepoFilesResult & { contentHash: string }> {
  return mutateArtifactRepo({
    author: input.author,
    branch: input.branch,
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
  message: string;
  newString: string;
  oldString: string;
  path: string;
  remote: string;
  replaceAll?: boolean;
  token: string;
}): Promise<EditRepoFileResult & { contentHash: string }> {
  return mutateArtifactRepo({
    author: input.author,
    branch: input.branch,
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
  message: string;
  mutate: (repo: { filesystem: InMemoryFs; git: ReturnType<typeof createGit> }) => Promise<Extra>;
  remote: string;
  token: string;
}): Promise<CommitRepoFilesResult & { contentHash: string } & Extra> {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = { password: input.token, username: "x" };

  await git.clone({
    branch: input.branch,
    singleBranch: true,
    url: input.remote,
    ...credentials,
  });

  const extra = await input.mutate({ filesystem, git });
  const changedPaths = (await git.status()).map((entry) => entry.filepath).sort();
  if (changedPaths.length === 0) {
    const [head] = await git.log({ depth: 1 });
    if (!head) throw new Error("Repo has no commits.");
    return {
      branch: input.branch,
      changedPaths,
      commitOid: head.oid,
      contentHash: await repoContentHash(await readCheckoutFiles(filesystem)),
      noChanges: true,
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
  // No force: writes are serialized by the DO's #writeChain, so a fresh
  // clone + one commit is always a fast-forward — a non-fast-forward push
  // here means an out-of-band writer and should fail loudly, not clobber.
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
    contentHash: await repoContentHash(await readCheckoutFiles(filesystem)),
    noChanges: false,
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
    typeof record.repo === "string"
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

/** All committed files of a checkout as one path -> content map (skips
 * .git). Content-hash sites (commit/seed) need every byte; the masked
 * snapshot path deliberately walks paths first instead. */
async function readCheckoutFiles(filesystem: InMemoryFs): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await walkCheckoutPaths(filesystem)) {
    files[path] = await filesystem.readFile(`${REPO_DIR}/${path}`);
  }
  return files;
}

/** All committed files of a checkout as one path -> raw bytes map (skips
 * .git) — the tree-diff input for `commitDetails`, where a utf8 decode before
 * the binary sniff would corrupt exactly the files it needs to sniff. */
async function readCheckoutBytes(filesystem: InMemoryFs): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const path of await walkCheckoutPaths(filesystem)) {
    files.set(path, await filesystem.readFileBytes(`${REPO_DIR}/${path}`));
  }
  return files;
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

/** All committed file paths of a checkout (skips .git). */
async function walkCheckoutPaths(filesystem: InMemoryFs): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await filesystem.readdir(dir)) {
      if (dir === REPO_DIR && entry === ".git") continue;
      const absolute = `${dir}/${entry}`;
      const stat = await filesystem.stat(absolute);
      if (stat.type === "directory") await walk(absolute);
      else paths.push(absolute.slice(REPO_DIR.length + 1));
    }
  };
  await walk(REPO_DIR);
  return paths;
}

/**
 * Whole-checkout content identity. Build keys hash this plus the ref's masks,
 * so a commit touching only mask-excluded files still changes every build key
 * for the repo — a spurious cache miss (correct output, one extra build), the
 * accepted cost of getting fresh-seed artifact dedupe without per-mask hashes.
 */
async function repoContentHash(files: Record<string, string>): Promise<string> {
  return await stableSha256({ files, type: "repo-content" });
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
