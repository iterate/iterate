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
import { stableSha256 } from "../workers/utils.ts";
import type { ResolvedWorkerSource } from "../workers/worker-loader.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { CommitRepoFilesInput, CommitRepoFilesResult, RepoFileChange } from "../../types.ts";
import { PROJECT_WORKER_SOURCE_PATH, RepoArtifactNameCodec } from "./utils.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const REPO_DEFAULT_BRANCH = "main";
const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const REPO_DIR = "/repo";
const WORKER_SOURCE_PROJECTION_VERSION = 1;

type WorkerSourceProjection = ResolvedWorkerSource & {
  branch: string;
  commitOid: string;
  sourcePath: string;
  version: typeof WORKER_SOURCE_PROJECTION_VERSION;
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
    RepoProcessorContract.slug,
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

  async getWorkerSource(args: { path: string }): Promise<ResolvedWorkerSource> {
    const sourcePath = normalizeRepoFilePath(args.path);

    // Hot path: project ingress and dynamic worker calls ask the Repo DO for
    // loader-ready source on every request. The synchronous KV API already has
    // the DO storage cache behind it, so a durable projection is enough here; an
    // extra JS Map would only duplicate the runtime's own cache and make
    // invalidation harder to reason about.
    const projected = this.projectedWorkerSource({
      branch: REPO_DEFAULT_BRANCH,
      sourcePath,
    });
    if (projected !== null) return projected;

    return await this.materializeWorkerSourceProjection({
      branch: REPO_DEFAULT_BRANCH,
      overwrite: false,
      sourcePath,
    });
  }

  whoami(): string {
    return `repo ${this.#name.projectId}:${this.#name.path}`;
  }

  async commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    const parsed = parseCommitFilesInput(input);
    const repo = await this.repoGitAccess();
    const result = await commitFilesToArtifactRepo({
      author: parsed.author,
      branch: parsed.branch ?? repo.defaultBranch,
      changes: parsed.changes,
      message: parsed.message,
      remote: repo.remote,
      token: repo.token,
    });

    if (result.branch === repo.defaultBranch) {
      // `commitFiles()` is our read-your-write boundary. Once it returns, callers
      // expect `project.worker` and explicit repo-backed worker refs to see the
      // pushed source, so main-branch commits refresh the durable source
      // projection before the RPC resolves.
      await this.refreshWorkerSourceProjectionsAfterMainCommit(result.changedPaths);
    }

    return result;
  }

  private projectedWorkerSource(input: { branch: string; sourcePath: string }) {
    const key = workerSourceProjectionStorageKey(input);
    const value = this.ctx.storage.kv.get<unknown>(key);
    if (
      isWorkerSourceProjection(value) &&
      value.branch === input.branch &&
      value.sourcePath === input.sourcePath &&
      value.mainModule === input.sourcePath &&
      typeof value.modules[input.sourcePath] === "string"
    ) {
      return projectionToResolvedWorkerSource(value);
    }

    if (value !== undefined) {
      // This projection is an optimization over Git, not the repo authority. If a
      // future shape change or failed deploy leaves junk in storage, discard it
      // and fall back to Git materialization instead of serving ambiguous code.
      this.ctx.storage.kv.delete(key);
    }
    return null;
  }

  private async materializeWorkerSourceProjection(input: {
    branch: string;
    overwrite: boolean;
    sourcePath: string;
  }): Promise<ResolvedWorkerSource> {
    // This clone is intentionally outside the request hot path once the
    // projection exists. We still keep it here as a lazy repair path for old
    // projects and freshly-created repos, so project creation does not need a new
    // repo/source-updated event just to seed the cache.
    const repo = await this.repoGitAccess();
    const source = await readRepoWorkerSource({
      branch: input.branch,
      path: input.sourcePath,
      remote: repo.remote,
      token: repo.token,
    });
    const projection = await workerSourceProjection({
      branch: input.branch,
      content: source.content,
      commitOid: source.commitOid,
      sourcePath: input.sourcePath,
    });

    if (!input.overwrite) {
      // Lazy reads only fill a missing projection. A concurrent commit can push a
      // newer worker and overwrite the latest pointer while this old clone is
      // still running; in that case we return the newer durable projection and
      // deliberately do not put the stale clone back into storage.
      const current = this.projectedWorkerSource(input);
      if (current !== null) return current;
    }

    this.ctx.storage.kv.put(workerSourceProjectionStorageKey(input), projection);
    return projectionToResolvedWorkerSource(projection);
  }

  private async refreshWorkerSourceProjectionsAfterMainCommit(changedPaths: string[]) {
    // Minimal ITX v4 currently treats repo-backed workers as single-file JS
    // modules. Always refreshing the seeded project worker means README-only
    // commits still advance the source cache key to the latest repo commit, while
    // changed `.js` paths keep explicit dynamic refs from serving stale code.
    const sourcePaths = new Set([
      PROJECT_WORKER_SOURCE_PATH,
      ...changedPaths.filter((path) => path.endsWith(".js")),
    ]);

    for (const sourcePath of sourcePaths) {
      try {
        await this.materializeWorkerSourceProjection({
          branch: REPO_DEFAULT_BRANCH,
          overwrite: true,
          sourcePath,
        });
      } catch (error) {
        if (!(error instanceof RepoSourceFileMissingError)) throw error;

        // If a commit deletes a previously materialized worker file, the durable
        // projection must disappear with it. Keeping the old projection would make
        // `project.worker` keep serving code that is no longer in the repo.
        this.ctx.storage.kv.delete(
          workerSourceProjectionStorageKey({ branch: REPO_DEFAULT_BRANCH, sourcePath }),
        );
      }
    }
  }

  private async createArtifactRepo(_input: { path: string; projectId: string | null }) {
    const artifactName = this.artifactName();
    await this.getOrCreateArtifact(artifactName);
    const defaultBranch = REPO_DEFAULT_BRANCH;
    const remote = this.artifactRemote(artifactName);
    const token = await artifactToken(this.requireArtifacts(), artifactName);

    await seedArtifactRepo({
      branch: defaultBranch,
      files: PROJECT_REPO_INITIAL_FILES,
      remote,
      token,
    });

    return {
      artifactName,
      defaultBranch,
      remote,
    };
  }

  private async repoGitAccess() {
    const artifactName = this.artifactName();
    const artifacts = this.requireArtifacts();
    return {
      defaultBranch: REPO_DEFAULT_BRANCH,
      remote: this.artifactRemote(artifactName),
      token: await artifactToken(artifacts, artifactName),
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
}) {
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
}

async function commitFilesToArtifactRepo(input: {
  author?: { email: string; name: string };
  branch: string;
  changes: RepoFileChange[];
  message: string;
  remote: string;
  token: string;
}): Promise<CommitRepoFilesResult> {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = { password: input.token, username: "x" };

  await git.clone({
    branch: input.branch,
    singleBranch: true,
    url: input.remote,
    ...credentials,
  });

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

  const changedPaths = (await git.status()).map((entry) => entry.filepath).sort();
  if (changedPaths.length === 0) {
    const [head] = await git.log({ depth: 1 });
    if (!head) throw new Error("Repo has no commits.");
    return {
      branch: input.branch,
      changedPaths,
      commitOid: head.oid,
      noChanges: true,
    };
  }

  const commit = await git.commit({
    author: input.author ?? { email: "support@iterate.com", name: "Iterate" },
    message: input.message,
  });

  const pushed = await git.push({
    force: true,
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
    noChanges: false,
  };
}

class RepoSourceFileMissingError extends Error {
  constructor(path: string) {
    super(`repo does not contain ${path}`);
  }
}

async function readRepoWorkerSource(input: {
  branch: string;
  path: string;
  remote: string;
  token: string;
}) {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  await git.clone({
    branch: input.branch,
    depth: 1,
    singleBranch: true,
    url: input.remote,
    username: "x",
    password: input.token,
  });

  const [head] = await git.log({ depth: 1 });
  if (!head) throw new Error("Repo has no commits.");

  const absolutePath = `${REPO_DIR}/${input.path}`;
  if (!(await filesystem.exists(absolutePath))) throw new RepoSourceFileMissingError(input.path);
  return {
    commitOid: head.oid,
    content: await filesystem.readFile(absolutePath),
  };
}

async function workerSourceProjection(input: {
  branch: string;
  content: string;
  commitOid: string;
  sourcePath: string;
}): Promise<WorkerSourceProjection> {
  return {
    branch: input.branch,
    cacheKey: await stableSha256({
      commitOid: input.commitOid,
      path: input.sourcePath,
      type: "repo-commit-worker-source",
    }),
    commitOid: input.commitOid,
    mainModule: input.sourcePath,
    modules: { [input.sourcePath]: input.content },
    sourcePath: input.sourcePath,
    version: WORKER_SOURCE_PROJECTION_VERSION,
  };
}

function projectionToResolvedWorkerSource(
  projection: WorkerSourceProjection,
): ResolvedWorkerSource {
  return {
    cacheKey: projection.cacheKey,
    mainModule: projection.mainModule,
    modules: projection.modules,
  };
}

function workerSourceProjectionStorageKey(input: { branch: string; sourcePath: string }) {
  // The value is "latest source at this branch/path", not immutable history. The
  // immutable identity lives inside the projection as `commitOid` and `cacheKey`,
  // which is what Worker Loader and stateful facet restart checks consume.
  return `repo-worker-source:${input.branch}:${input.sourcePath}`;
}

function isWorkerSourceProjection(value: unknown): value is WorkerSourceProjection {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<WorkerSourceProjection>;
  return (
    record.version === WORKER_SOURCE_PROJECTION_VERSION &&
    typeof record.branch === "string" &&
    typeof record.cacheKey === "string" &&
    typeof record.commitOid === "string" &&
    typeof record.mainModule === "string" &&
    typeof record.sourcePath === "string" &&
    record.modules !== null &&
    typeof record.modules === "object" &&
    Object.values(record.modules).every((module) => typeof module === "string")
  );
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
