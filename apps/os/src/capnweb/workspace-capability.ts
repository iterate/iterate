import { RpcTarget } from "cloudflare:workers";
import type { ProjectScopes } from "./iterate-context-capability.ts";
import type { AppContext } from "~/context.ts";
import type { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

type WorkspaceClient = Pick<
  WorkspaceCapability,
  "gitAdd" | "gitClone" | "gitCommit" | "gitPush" | "gitStatus" | "readFile" | "writeFile"
>;

export type WorkspaceAddressInput = string | { namespace: string; slug: string };
type ProjectWorkspaceAddressInput = string | { slug: string };

export class RootWorkspacesCapability extends RpcTarget {
  constructor(private readonly input: { context: AppContext; scopes: ProjectScopes }) {
    super();
  }

  get(input: WorkspaceAddressInput) {
    const address = parseWorkspaceAddress(input);
    assertNamespaceAccess({ namespace: address.namespace, scopes: this.input.scopes });
    return new ProjectWorkspaceCapability({
      context: this.input.context,
      projectId: () => address.namespace,
      workspaceId: address.slug,
    });
  }
}

export class ProjectWorkspacesCapability extends RpcTarget {
  constructor(
    private readonly input: {
      context: AppContext;
      projectId: () => Promise<string> | string;
    },
  ) {
    super();
  }

  get(input: ProjectWorkspaceAddressInput) {
    return new ProjectWorkspaceCapability({
      context: this.input.context,
      projectId: () => this.projectId(),
      workspaceId: typeof input === "string" ? input : input.slug,
    });
  }

  private async projectId() {
    return await this.input.projectId();
  }
}

export class ProjectWorkspaceCapability extends RpcTarget {
  #git?: ProjectWorkspaceGitCapability;
  readonly #input: {
    context: AppContext;
    projectId: () => Promise<string> | string;
    workspaceId?: string;
  };

  constructor(input: {
    context: AppContext;
    projectId: () => Promise<string> | string;
    workspaceId?: string;
  }) {
    super();
    this.#input = input;
  }

  get git() {
    return (this.#git ??= new ProjectWorkspaceGitCapability(() => this.workspace()));
  }

  async readFile(path: string) {
    return await (await this.workspace()).readFile(path);
  }

  async writeFile(path: string, content: string) {
    return await (await this.workspace()).writeFile(path, content);
  }

  async describe() {
    return {
      namespace: await this.projectId(),
      slug: this.#input.workspaceId ?? "capnweb",
    };
  }

  private async workspace(): Promise<WorkspaceClient> {
    const workspaceCapability = this.#input.context.workerExports?.WorkspaceCapability as unknown as
      | ((options: { props: { projectId: string; workspaceId: string } }) => WorkspaceClient)
      | undefined;
    if (!workspaceCapability) throw new Error("WorkspaceCapability export is not available.");
    return workspaceCapability({
      props: {
        projectId: await this.projectId(),
        workspaceId: this.#input.workspaceId ?? "capnweb",
      },
    });
  }

  private async projectId() {
    return await this.#input.projectId();
  }
}

function parseWorkspaceAddress(input: WorkspaceAddressInput) {
  if (typeof input !== "string") return input;
  const separatorIndex = input.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
    throw new Error(`Workspace address must look like namespace:slug, received ${input}.`);
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

class ProjectWorkspaceGitCapability extends RpcTarget {
  constructor(private readonly workspace: () => Promise<WorkspaceClient>) {
    super();
  }

  async add(input: Record<string, unknown>) {
    return await (await this.workspace()).gitAdd(input);
  }

  async clone(input: Record<string, unknown>) {
    return await (await this.workspace()).gitClone(input);
  }

  async commit(input: Record<string, unknown>) {
    return await (await this.workspace()).gitCommit(input);
  }

  async push(input: Record<string, unknown>) {
    return await (await this.workspace()).gitPush(input);
  }

  async status(input: Record<string, unknown>) {
    return await (await this.workspace()).gitStatus(input);
  }
}
