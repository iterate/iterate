import { DurableObject } from "cloudflare:workers";
import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { filterWorkerSnapshotPaths } from "../workers/source-masks.ts";
import { stableSha256 } from "../workers/utils.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type {
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  EditRepoFileInput,
  EditRepoFileResult,
  RepoFileChange,
} from "./types.ts";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import { RepoArtifactNameCodec } from "./utils.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const REPO_DEFAULT_BRANCH = "main";
const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const REPO_DIR = "/repo";

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
  });
  readonly #repoProcessor = this.#host.add(
    (deps) =>
      new RepoProcessor({
        ...deps,
        createRepoArtifact: (input) => this.createArtifactRepo(input),
        path: this.#name.path,
        projectId: this.#name.projectId,
      }),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#host.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#repoProcessor);
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
    const repo = await this.gitAccess();
    const branch = input.branch ?? repo.defaultBranch;

    const clone = async () => {
      const filesystem = new InMemoryFs();
      const git = createGit(filesystem, REPO_DIR);
      const credentials = { password: repo.token, username: "x" };
      if (input.commitOid !== undefined) {
        // Pinned commits need history: a shallow clone only contains the
        // branch tip. Project repos are small; correctness beats depth tuning.
        await git.clone({ branch, url: repo.remote, ...credentials });
        await git.checkout({ ref: input.commitOid, force: true });
      } else {
        await git.clone({
          branch,
          depth: 1,
          singleBranch: true,
          url: repo.remote,
          ...credentials,
        });
      }
      const [head] = await git.log({ depth: 1 });
      if (!head) throw new Error("Repo has no commits.");
      return { filesystem, head };
    };

    let { filesystem, head } = await clone();
    if (input.commitOid !== undefined) {
      if (head.oid !== input.commitOid) {
        throw new Error(`Repo checkout of ${input.commitOid} landed on ${head.oid}.`);
      }
    } else {
      // Read-your-write over the eventually consistent Artifacts remote: a
      // clone right after a push can serve the previous HEAD (#recordPushedHead
      // has the full story). Retry until the clone reaches the recorded push.
      const expected = this.ctx.storage.kv.get<string>(`repo-pushed-head:${branch}`);
      for (let attempt = 1; expected && head.oid !== expected && attempt <= 5; attempt++) {
        console.warn(
          `repo clone is behind the last push (saw ${head.oid}, pushed ${expected}); retry ${attempt}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        ({ filesystem, head } = await clone());
      }
    }

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

    return {
      branch: result.branch,
      changedPaths: result.changedPaths,
      commitOid: result.commitOid,
      noChanges: result.noChanges,
      occurrenceCount: result.occurrenceCount,
      path: result.path,
    };
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

  /** Committed file contents at HEAD, or null when the path does not exist. */
  async readFile(input: { path: string }): Promise<RepoFileRead | null> {
    const path = normalizeRepoFilePath(input.path);
    // Exact map lookup, deliberately not an include mask: glob metacharacters
    // in a filename must not change what this reads.
    const { commitOid, files } = await this.getFilesSnapshot();
    const content = files[path];
    return content === undefined ? null : { commitOid, content, path };
  }

  /** All committed file paths at HEAD. */
  async listFiles(): Promise<{ commitOid: string; paths: string[] }> {
    const { commitOid, files } = await this.getFilesSnapshot();
    return { commitOid, paths: Object.keys(files).sort() };
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
        files: PROJECT_REPO_INITIAL_FILES,
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
        throw error;
      },
    );
    return {
      defaultBranch: REPO_DEFAULT_BRANCH,
      remote: this.artifactRemote(artifactName),
      token: await this.#artifactTokenPromise,
    };
  }

  private async getOrCreateArtifact(name: string) {
    try {
      return await this.requireArtifacts().create(name, {
        setDefaultBranch: REPO_DEFAULT_BRANCH,
      });
    } catch {
      return await this.requireArtifacts().get(name);
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
      author: { email: "support@iterate.com", name: "Iterate" },
      message: "Seed minimal ITX project worker",
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
        await filesystem.writeFile(absolutePath, change.content);
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
    author: input.author ?? { email: "support@iterate.com", name: "Iterate" },
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

type RepoFileRead = { commitOid: string; content: string; path: string };

function repoHeadStorageKey(branch: string) {
  // The value is "latest head at this branch" ({ commitOid, contentHash }),
  // not immutable history — exactly the late-bound pointer branch-backed
  // worker file sources resolve through before pinning a build. The version
  // segment makes a contentHash recipe change a clean cache flush instead of
  // old and new hashes silently mixing in build keys.
  return `repo-head:v1:${branch}`;
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
