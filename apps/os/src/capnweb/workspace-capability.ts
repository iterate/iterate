import { RpcTarget } from "cloudflare:workers";
import type { AppContext } from "~/context.ts";
import type { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

type WorkspaceClient = Pick<
  WorkspaceCapability,
  "gitAdd" | "gitClone" | "gitCommit" | "gitPush" | "gitStatus" | "readFile" | "writeFile"
>;

export class ProjectWorkspaceCapability extends RpcTarget {
  #git?: ProjectWorkspaceGitCapability;
  readonly #workspace: WorkspaceClient;

  constructor(input: { context: AppContext; projectId: string }) {
    super();
    const workspaceCapability = input.context.workerExports?.WorkspaceCapability as unknown as
      | ((options: { props: { projectId: string; workspaceId: string } }) => WorkspaceClient)
      | undefined;
    if (!workspaceCapability) throw new Error("WorkspaceCapability export is not available.");
    this.#workspace = workspaceCapability({
      props: {
        projectId: input.projectId,
        workspaceId: "capnweb",
      },
    });
  }

  get git() {
    return (this.#git ??= new ProjectWorkspaceGitCapability(this.#workspace));
  }

  async readFile(path: string) {
    return await this.#workspace.readFile(path);
  }

  async writeFile(path: string, content: string) {
    return await this.#workspace.writeFile(path, content);
  }
}

class ProjectWorkspaceGitCapability extends RpcTarget {
  constructor(private readonly workspace: WorkspaceClient) {
    super();
  }

  async add(input: Record<string, unknown>) {
    return await this.workspace.gitAdd(input);
  }

  async clone(input: Record<string, unknown>) {
    return await this.workspace.gitClone(input);
  }

  async commit(input: Record<string, unknown>) {
    return await this.workspace.gitCommit(input);
  }

  async push(input: Record<string, unknown>) {
    return await this.workspace.gitPush(input);
  }

  async status(input: Record<string, unknown>) {
    return await this.workspace.gitStatus(input);
  }
}
