import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  RepoInfo,
  RepoDurableObject,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getRepoDurableObjectName } from "~/domains/repos/repo-durable-object-name.ts";
import {
  isRepoAlreadyExistsError,
  isRepoNotCreatedError,
  isRepoNotFoundError,
} from "~/domains/repos/repo-errors.ts";
import {
  ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
  PROJECT_REPO_PATH,
} from "~/domains/repos/project-repo.ts";
import type {
  CommitRepoFilesInput,
  ListRepoFilesInput,
  ReadRepoFilesInput,
  ReadRepoLogInput,
} from "~/domains/repos/repo-git.ts";
import { getProjectDurableObjectStub } from "~/domains/projects/durable-objects/project-durable-object-ref.ts";
import type { ProjectProcessorState } from "~/domains/projects/stream-processors/project/contract.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";

export type ReposCapabilityEnv = {
  REPO?: DurableObjectNamespace<RepoDurableObject>;
};

export type ReposCapabilityProps = {
  projectId: string;
};

export type RepoCatalogRecord = {
  createdAt: string;
  lastWokenAt: string;
  name: string;
  path: string;
  projectId: string;
};

type ReposCapabilityClient = Pick<
  ReposCapability,
  "create" | "createInfo" | "ensureProjectRepoInfo" | "get" | "getInfo" | "list"
>;
const projectRepoInfoPromises = new Map<string, Promise<RepoInfo>>();

export class RepoHandle extends RpcTarget {
  readonly #repo: DurableObjectStub<RepoDurableObject>;

  constructor(repo: DurableObjectStub<RepoDurableObject>) {
    super();
    this.#repo = repo;
  }

  async getInfo(): Promise<RepoInfo> {
    return await this.#repo.getInfo();
  }

  async refreshWriteToken(): Promise<RepoInfo> {
    return await this.#repo.refreshWriteToken();
  }

  async commitFiles(input: CommitRepoFilesInput) {
    return await this.#repo.commitFiles(input);
  }

  async readFiles(input: ReadRepoFilesInput) {
    return await this.#repo.readFiles(input);
  }

  async listFiles(input: ListRepoFilesInput = {}) {
    return await this.#repo.listFiles(input);
  }

  async readLog(input: ReadRepoLogInput = {}) {
    return await this.#repo.readLog(input);
  }

  getArtifact() {
    return this.#repo.getArtifact();
  }
}

export class ReposCapability extends WorkerEntrypoint<ReposCapabilityEnv, ReposCapabilityProps> {
  /** The itx kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
  }

  async create(input: { path: string; projectSlug?: string }) {
    const namespace = this.requireRepoNamespace();
    const repo = namespace.getByName(this.repoName(input.path));

    try {
      await repo.getInfo();
      throw new Error(`Repo ${input.path} already exists.`);
    } catch (error) {
      if (!isRepoNotCreatedError(error)) throw error;
    }

    await repo.createRepo({ projectSlug: input.projectSlug });
    return new RepoHandle(repo);
  }

  async createInfo(input: { path: string; projectSlug?: string }): Promise<RepoInfo> {
    return await (await this.create(input)).getInfo();
  }

  async get(input: { path: string }) {
    const repo = this.requireRepoNamespace().getByName(this.repoName(input.path));
    try {
      await repo.getInfo();
    } catch (error) {
      if (!isRepoNotCreatedError(error)) throw error;
      throw new Error(`Repo ${input.path} not found.`);
    }

    return new RepoHandle(repo);
  }

  async getInfo(input: { path: string }): Promise<RepoInfo> {
    return await (await this.get(input)).getInfo();
  }

  async ensureProjectRepoInfo(input: { projectSlug: string | null }): Promise<RepoInfo> {
    return await ensureProjectRepoInfoForProject({
      env: this.env,
      projectId: this.ctx.props.projectId,
      projectSlug: input.projectSlug,
    });
  }

  async list(): Promise<RepoCatalogRecord[]> {
    const state = await readProjectProcessorState(this.ctx.props.projectId);

    const repos = await Promise.all(
      state.repos.map(async (child) => {
        const repo = this.toRepoCatalogRecord(child);
        try {
          await this.getInfo({ path: repo.path });
          return repo;
        } catch (error) {
          if (isRepoNotCreatedError(error) || isRepoNotFoundError(error)) return null;
          throw error;
        }
      }),
    );

    return repos.filter((repo): repo is RepoCatalogRecord => repo !== null);
  }

  private requireRepoNamespace() {
    if (!this.env.REPO) {
      throw new Error("REPO Durable Object namespace is not configured.");
    }

    return this.env.REPO;
  }

  private repoName(path: string): string {
    return getRepoDurableObjectName({
      path,
      projectId: this.ctx.props.projectId,
    });
  }

  private toRepoCatalogRecord(repo: ProjectProcessorState["repos"][number]): RepoCatalogRecord {
    return {
      createdAt: repo.createdAt,
      lastWokenAt: repo.createdAt,
      name: this.repoName(repo.path),
      path: repo.path,
      projectId: this.ctx.props.projectId,
    };
  }
}

export { ReposCapability as RepoCapability };

export async function ensureProjectRepoInfoForProject(input: {
  env: Pick<ReposCapabilityEnv, "REPO">;
  projectId: string;
  projectSlug: string | null;
}): Promise<RepoInfo> {
  const key = `${input.projectId}:${PROJECT_REPO_PATH}`;
  const existingPromise = projectRepoInfoPromises.get(key);
  if (existingPromise) return await existingPromise;

  const promise = createOrReadProjectRepoInfoForProject(input);
  projectRepoInfoPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    if (projectRepoInfoPromises.get(key) === promise) {
      projectRepoInfoPromises.delete(key);
    }
  }
}

async function createOrReadProjectRepoInfoForProject(input: {
  env: Pick<ReposCapabilityEnv, "REPO">;
  projectId: string;
  projectSlug: string | null;
}): Promise<RepoInfo> {
  const namespace = requireRepoNamespace(input.env);
  const name = getRepoDurableObjectName({
    path: PROJECT_REPO_PATH,
    projectId: input.projectId,
  });
  const repo = namespace.getByName(name);

  try {
    return await repo.getInfo();
  } catch (error) {
    if (!isRepoNotCreatedError(error)) {
      throw error;
    }
  }

  try {
    return await repo.createRepo({
      projectSlug: input.projectSlug || undefined,
      source: {
        artifactName: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
        description: `Project repo for ${input.projectSlug || input.projectId}`,
        kind: "artifact-fork",
      },
    });
  } catch (error) {
    if (isRepoAlreadyExistsError(error)) {
      return await repo.getInfo();
    }

    throw error;
  }
}

export function getReposCapability(input: {
  exports: Pick<Cloudflare.Exports, "ReposCapability"> | undefined;
  props: ReposCapabilityProps;
}): ReposCapabilityClient {
  if (!input.exports) {
    throw new Error("ReposCapability export is not available.");
  }

  const reposCapability = input.exports.ReposCapability as unknown as (options: {
    props: ReposCapabilityProps;
  }) => ReposCapabilityClient;

  return reposCapability({ props: input.props });
}

function requireRepoNamespace(env: Pick<ReposCapabilityEnv, "REPO">) {
  if (!env.REPO) {
    throw new Error("REPO Durable Object namespace is not configured.");
  }

  return env.REPO;
}

export { getRepoDurableObjectName };

async function readProjectProcessorState(projectId: string): Promise<ProjectProcessorState> {
  const project = getProjectDurableObjectStub(projectId);
  const processor = await project.processor;
  return (await processor.snapshot()).state;
}
