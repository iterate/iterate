import { RpcTarget } from "cloudflare:workers";
import type { ProjectScopes } from "./iterate-context-capability.ts";
import type { AppContext } from "~/context.ts";
import {
  ensureIterateConfigInfoForProject,
  getReposCapability,
  type ReposCapability,
  type ReposCapabilityEnv,
} from "~/domains/repos/entrypoints/repo-capability.ts";

type ReposClient = Pick<
  ReposCapability,
  "create" | "createInfo" | "ensureIterateConfigInfo" | "get" | "getInfo" | "list"
>;
export type RepoAddressInput = string | { namespace: string; slug: string };
type ProjectRepoAddressInput = string | { slug: string };
type RepoCreateInput = { projectSlug?: string; slug: string };
type RepoEnsureIterateConfigInfoInput = { projectSlug: string | null };
type RepoGetInput = { slug: string };

export class RootReposCapability extends RpcTarget {
  constructor(private readonly input: { context: AppContext; scopes: ProjectScopes }) {
    super();
  }

  async create(input: { namespace: string; projectSlug?: string; slug: string }) {
    assertNamespaceAccess({ namespace: input.namespace, scopes: this.input.scopes });
    return await this.repos(input.namespace).create({
      projectSlug: input.projectSlug,
      slug: input.slug,
    });
  }

  get(input: RepoAddressInput) {
    const address = parseRepoAddress(input);
    assertNamespaceAccess({ namespace: address.namespace, scopes: this.input.scopes });
    return new RepoCapability({
      context: this.input.context,
      namespace: () => address.namespace,
      slug: address.slug,
    });
  }

  async list(input: { namespace: string }) {
    assertNamespaceAccess({ namespace: input.namespace, scopes: this.input.scopes });
    return await this.repos(input.namespace).list();
  }

  private repos(namespace: string): ReposClient {
    return getReposCapability({
      exports: this.input.context.workerExports,
      props: { projectId: namespace },
    });
  }
}

export class ProjectReposCapability extends RpcTarget {
  constructor(
    private readonly input: {
      context: AppContext;
      projectId: () => Promise<string> | string;
    },
  ) {
    super();
  }

  async create(input: RepoCreateInput) {
    return await (await this.repos()).create(input);
  }

  async createInfo(input: RepoCreateInput) {
    return await (await this.repos()).createInfo(input);
  }

  async ensureIterateConfigInfo(input: RepoEnsureIterateConfigInfoInput) {
    return await ensureIterateConfigInfoForProject({
      env: this.input.context.callableEnv as Pick<ReposCapabilityEnv, "REPO">,
      projectId: await this.projectId(),
      projectSlug: input.projectSlug,
    });
  }

  get(input: ProjectRepoAddressInput) {
    return new RepoCapability({
      context: this.input.context,
      namespace: () => this.projectId(),
      slug: typeof input === "string" ? input : input.slug,
    });
  }

  async getInfo(input: RepoGetInput) {
    return await (await this.repos()).getInfo(input);
  }

  async list() {
    return await (await this.repos()).list();
  }

  private async repos(): Promise<ReposClient> {
    return getReposCapability({
      exports: this.input.context.workerExports,
      props: { projectId: await this.projectId() },
    });
  }

  private async projectId() {
    return await this.input.projectId();
  }
}

export class RepoCapability extends RpcTarget {
  constructor(
    private readonly input: {
      context: AppContext;
      namespace: () => Promise<string> | string;
      slug: string;
    },
  ) {
    super();
  }

  async get() {
    return await (await this.repos()).get({ slug: this.input.slug });
  }

  async getInfo() {
    return await (await this.repos()).getInfo({ slug: this.input.slug });
  }

  async refreshWriteToken() {
    return await (await this.get()).refreshWriteToken();
  }

  getArtifact() {
    return this.get().then((repo) => repo.getArtifact());
  }

  async describe() {
    return {
      namespace: await this.namespace(),
      slug: this.input.slug,
    };
  }

  private async repos(): Promise<ReposClient> {
    return getReposCapability({
      exports: this.input.context.workerExports,
      props: { projectId: await this.namespace() },
    });
  }

  private async namespace() {
    return await this.input.namespace();
  }
}

function parseRepoAddress(input: RepoAddressInput) {
  if (typeof input !== "string") return input;
  const separatorIndex = input.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
    throw new Error(`Repo address must look like namespace:slug, received ${input}.`);
  }
  return {
    namespace: input.slice(0, separatorIndex),
    slug: input.slice(separatorIndex + 1),
  };
}

function assertNamespaceAccess(input: { namespace: string; scopes: ProjectScopes }) {
  if (input.scopes.projects === "all") return;
  if (input.scopes.projects.includes(input.namespace)) return;
  throw new Error(`Missing namespace authority for ${input.namespace}.`);
}
