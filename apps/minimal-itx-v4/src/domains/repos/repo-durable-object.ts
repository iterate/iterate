import { DurableObject } from "cloudflare:workers";
import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { StreamRpcTarget } from "../streams/rpc-targets.ts";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { stableSha256 } from "../workers/source-cache-key.ts";
import type { ResolvedWorkerSource } from "../workers/worker-loader.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { CommitRepoFilesInput, CommitRepoFilesResult, RepoFileChange } from "./types.ts";
import { RepoArtifactNameCodec } from "./repo-artifact-name.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const REPO_DEFAULT_BRANCH = "main";
const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const REPO_DIR = "/repo";

export class RepoDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #host = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host.add(
      RepoProcessorContract.slug,
      (deps) =>
        new RepoProcessor({
          ...deps,
          createRepoArtifact: (input) => this.createArtifactRepo(input),
          path: this.#name.path,
          projectId: this.#name.projectId,
        }),
    );
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#host.requestStreamSubscription(args);
  }

  async getWorkerSource(args: { path: string }): Promise<ResolvedWorkerSource> {
    const repo = await this.repoGitAccess();
    const tree = await readRepoModules({
      branch: repo.defaultBranch,
      remote: repo.remote,
      token: repo.token,
    });

    if (!(args.path in tree.modules)) {
      throw new Error(`repo ${this.#name.path} does not contain ${args.path}`);
    }

    return {
      cacheKey: await stableSha256({
        commitOid: tree.commitOid,
        path: args.path,
        type: "repo-commit-worker-source",
      }),
      mainModule: args.path,
      modules: tree.modules,
    };
  }

  whoami(): string {
    return `repo ${this.#name.projectId}:${this.#name.path}`;
  }

  async commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    const parsed = parseCommitFilesInput(input);
    const repo = await this.repoGitAccess();
    return await commitFilesToArtifactRepo({
      author: parsed.author,
      branch: parsed.branch ?? repo.defaultBranch,
      changes: parsed.changes,
      message: parsed.message,
      remote: repo.remote,
      token: repo.token,
    });
  }

  private async createArtifactRepo(_input: { path: string; projectId: string }) {
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

async function readRepoModules(input: { branch: string; remote: string; token: string }) {
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

  const modules: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await filesystem.readdirWithFileTypes(dir)) {
      if (dir === REPO_DIR && entry.name === ".git") continue;
      const entryPath = `${dir}/${entry.name}`;
      if (entry.type === "directory") {
        await walk(entryPath);
      } else if (entryPath.endsWith(".js")) {
        modules[entryPath.slice(REPO_DIR.length + 1)] = await filesystem.readFile(entryPath);
      }
    }
  };
  await walk(REPO_DIR);

  return { commitOid: head.oid, modules };
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
