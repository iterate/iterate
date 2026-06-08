import { RpcTarget } from "cloudflare:workers";
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
type RepoCreateInput = { projectSlug?: string; slug: string };
type RepoEnsureIterateConfigInfoInput = { projectSlug: string | null };
type RepoGetInput = { slug: string };

export class ProjectReposCapability extends RpcTarget {
  constructor(private readonly input: { context: AppContext; projectId: string }) {
    super();
  }

  async create(input: RepoCreateInput) {
    return await this.repos().create(input);
  }

  async createInfo(input: RepoCreateInput) {
    return await this.repos().createInfo(input);
  }

  async ensureIterateConfigInfo(input: RepoEnsureIterateConfigInfoInput) {
    return await ensureIterateConfigInfoForProject({
      env: this.input.context.callableEnv as Pick<ReposCapabilityEnv, "REPO">,
      projectId: this.input.projectId,
      projectSlug: input.projectSlug,
    });
  }

  async get(input: RepoGetInput) {
    return await this.repos().get(input);
  }

  async getInfo(input: RepoGetInput) {
    return await this.repos().getInfo(input);
  }

  async list() {
    return await this.repos().list();
  }

  private repos(): ReposClient {
    return getReposCapability({
      exports: this.input.context.workerExports,
      props: { projectId: this.input.projectId },
    });
  }
}
