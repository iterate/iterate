import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  getInitializedDoStub,
  listD1ObjectCatalogRecordsByIndex,
  type D1ObjectCatalogRecord,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type {
  RepoInfo,
  RepoDurableObject,
  RepoStructuredName,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getRepoDurableObjectName } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import {
  isRepoAlreadyExistsError,
  isRepoNotCreatedError,
  isRepoNotFoundError,
} from "~/domains/repos/repo-errors.ts";
import {
  ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
  ITERATE_CONFIG_REPO_SLUG,
} from "~/domains/repos/iterate-config-repo.ts";

type ReposCapabilityEnv = {
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
  | "create"
  | "createInfo"
  | "ensureIterateConfigGitAccess"
  | "ensureIterateConfigInfo"
  | "get"
  | "getGitAccess"
  | "getInfo"
  | "list"
>;
type RepoLifecycleCatalogRecord = D1ObjectCatalogRecord<RepoStructuredName>;

export class RepoHandle extends RpcTarget {
  readonly #repo: DurableObjectStub<RepoDurableObject>;

  constructor(repo: DurableObjectStub<RepoDurableObject>) {
    super();
    this.#repo = repo;
  }

  async getInfo(): Promise<RepoInfo> {
    return await this.#repo.getInfo();
  }

  async createGitAccess(): Promise<RepoInfo> {
    return await this.#repo.createGitAccess();
  }
}

export class ReposCapability extends WorkerEntrypoint<ReposCapabilityEnv, ReposCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};

    switch (input.functionPath.join(".")) {
      case "create":
        return await this.create({
          projectSlug: readOptionalString(options.projectSlug),
          slug: readSlug(options.slug),
        });
      case "get":
        return await this.get({ slug: readSlug(options.slug) });
      case "list":
        return await this.list();
      default:
        throw new Error(`ReposCapability does not implement ${input.functionPath.join(".")}`);
    }
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

  async getGitAccess(input: { slug: string }): Promise<RepoInfo> {
    return await (await this.get(input)).createGitAccess();
  }

  async ensureIterateConfigInfo(input: { projectSlug: string | null }): Promise<RepoInfo> {
    const namespace = this.requireRepoNamespace();
    const name = this.repoName(ITERATE_CONFIG_REPO_SLUG);
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
        projectSlug: input.projectSlug ?? undefined,
        source: {
          artifactName: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
          description: `Iterate config repo for ${input.projectSlug ?? this.ctx.props.projectId}`,
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

  async ensureIterateConfigGitAccess(input: { projectSlug: string | null }): Promise<RepoInfo> {
    await this.ensureIterateConfigInfo(input);
    return await this.getGitAccess({ slug: ITERATE_CONFIG_REPO_SLUG });
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

function readSlug(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Repo slug is required.");
  }

  const slug = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Repo slug must be lowercase kebab-case.");
  }

  return slug;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export { getRepoDurableObjectName };
