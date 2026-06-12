import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  getInitializedDoStub,
  listD1ObjectCatalogRecordsByIndex,
  type D1ObjectCatalogRecord,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type {
  RepoInfo,
  RepoDurableObject,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import {
  getRepoDurableObjectName,
  type RepoStructuredName,
} from "~/domains/repos/repo-durable-object-name.ts";
import {
  isRepoAlreadyExistsError,
  isRepoNotCreatedError,
  isRepoNotFoundError,
} from "~/domains/repos/repo-errors.ts";
import {
  ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
  PROJECT_REPO_SLUG,
} from "~/domains/repos/project-repo.ts";
import type {
  CommitRepoFilesInput,
  ListRepoFilesInput,
  ReadRepoFilesInput,
  ReadRepoLogInput,
} from "~/domains/repos/repo-git.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";

export type ReposCapabilityEnv = {
  DO_CATALOG?: D1Database;
  REPO?: DurableObjectNamespace<RepoDurableObject>;
};

export type ReposCapabilityProps = {
  projectId: string;
};

export type RepoCatalogRecord = {
  createdAt: string;
  lastWokenAt: string;
  name: string;
  projectId: string;
  repoSlug: string;
};

type ReposCapabilityClient = Pick<
  ReposCapability,
  "create" | "createInfo" | "ensureProjectRepoInfo" | "get" | "getInfo" | "list"
>;
type RepoLifecycleCatalogRecord = D1ObjectCatalogRecord<RepoStructuredName>;
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

  async create(input: { projectSlug?: string; slug: string }) {
    const namespace = this.requireRepoNamespace();
    const name = this.repoName(input.slug);
    const existing = await getInitializedDoStub({
      allowCreate: false,
      namespace,
      name,
    });

    if (existing !== null) {
      let existingRepoIsUncreated = false;
      try {
        await existing.getInfo();
      } catch (error) {
        if (!isRepoNotCreatedError(error)) throw error;
        existingRepoIsUncreated = true;
      }

      if (!existingRepoIsUncreated) {
        throw new Error(`Repo ${input.slug} already exists.`);
      }
    }

    const repo = await getInitializedDoStub({
      allowCreate: true,
      namespace,
      name,
    });
    await repo.createRepo({ projectSlug: input.projectSlug });
    return new RepoHandle(repo);
  }

  async createInfo(input: { projectSlug?: string; slug: string }): Promise<RepoInfo> {
    return await (await this.create(input)).getInfo();
  }

  async get(input: { slug: string }) {
    const repo = await getInitializedDoStub({
      allowCreate: false,
      namespace: this.requireRepoNamespace(),
      name: this.repoName(input.slug),
    });

    if (repo === null) {
      throw new Error(`Repo ${input.slug} not found.`);
    }

    return new RepoHandle(repo);
  }

  async getInfo(input: { slug: string }): Promise<RepoInfo> {
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
    if (!this.env.DO_CATALOG) {
      throw new Error("DO_CATALOG binding is required to list Repos.");
    }

    const records = await listD1ObjectCatalogRecordsByIndex<RepoStructuredName>(
      this.env.DO_CATALOG,
      {
        className: "RepoDurableObject",
        indexName: "projectId",
        indexValue: this.ctx.props.projectId,
      },
    );

    const repos = await Promise.all(
      records.map(async (record) => {
        const repo = toRepoCatalogRecord(record);
        try {
          await this.getInfo({ slug: repo.repoSlug });
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

  private repoName(repoSlug: string): RepoStructuredName {
    return {
      projectId: this.ctx.props.projectId,
      repoSlug,
    };
  }
}

export { ReposCapability as RepoCapability };

export async function ensureProjectRepoInfoForProject(input: {
  env: Pick<ReposCapabilityEnv, "REPO">;
  projectId: string;
  projectSlug: string | null;
}): Promise<RepoInfo> {
  const key = `${input.projectId}:${PROJECT_REPO_SLUG}`;
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
  const name: RepoStructuredName = {
    projectId: input.projectId,
    repoSlug: PROJECT_REPO_SLUG,
  };
  const existing = await getInitializedDoStub({
    allowCreate: false,
    namespace,
    name,
  });

  if (existing !== null) {
    try {
      return await existing.getInfo();
    } catch (error) {
      if (!isRepoNotCreatedError(error)) {
        throw error;
      }
    }
  }

  const repo = await getInitializedDoStub({
    allowCreate: true,
    namespace,
    name,
  });

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

function toRepoCatalogRecord(record: RepoLifecycleCatalogRecord): RepoCatalogRecord {
  return {
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
    name: record.name,
    projectId: record.structuredName.projectId,
    repoSlug: record.structuredName.repoSlug,
  };
}

function requireRepoNamespace(env: Pick<ReposCapabilityEnv, "REPO">) {
  if (!env.REPO) {
    throw new Error("REPO Durable Object namespace is not configured.");
  }

  return env.REPO;
}

export { getRepoDurableObjectName };
