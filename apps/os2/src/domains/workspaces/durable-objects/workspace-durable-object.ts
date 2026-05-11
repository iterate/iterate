import { z } from "zod";
import { Workspace, WorkspaceFileSystem, createWorkspaceStateBackend } from "@cloudflare/shell";
import { createGit, type Git } from "@cloudflare/shell/git";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export type WorkspaceStructuredName = {
  projectId: string;
  workspaceId: string;
};

export type CloudflareShellState = Record<string, (...args: unknown[]) => Promise<unknown>>;

const WorkspaceStructuredName = z.object({
  projectId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

type WorkspaceEnv = {
  DO_CATALOG: D1Database;
};

const WorkspaceBase = createIterateDurableObjectBase<
  typeof WorkspaceStructuredName,
  Pick<WorkspaceEnv, "DO_CATALOG">
>({
  className: "WorkspaceDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
    workspaceId: (params) => params.workspaceId,
  },
  nameSchema: WorkspaceStructuredName,
});

export class WorkspaceDurableObject extends WorkspaceBase<WorkspaceEnv> {
  #workspace: Workspace | null = null;
  #filesystem: WorkspaceFileSystem | null = null;
  #git: Git | null = null;
  #state: CloudflareShellState | null = null;

  async cloudflareShellState(): Promise<CloudflareShellState> {
    await this.ensureStarted();
    return this.getShellState();
  }

  async cloudflareShellGit(): Promise<Git> {
    await this.ensureStarted();
    return this.getShellGit();
  }

  private getShellWorkspace() {
    if (this.#workspace === null) {
      this.#workspace = new Workspace({
        sql: this.ctx.storage.sql,
        name: () => this.name,
      });
    }

    return this.#workspace;
  }

  private getShellFileSystem() {
    if (this.#filesystem === null) {
      this.#filesystem = new WorkspaceFileSystem(this.getShellWorkspace());
    }

    return this.#filesystem;
  }

  private getShellGit() {
    if (this.#git === null) {
      this.#git = createGit(this.getShellFileSystem());
    }

    return this.#git;
  }

  private getShellState() {
    if (this.#state === null) {
      const backend = createWorkspaceStateBackend(this.getShellWorkspace());
      this.#state = createPlainMethodObject(backend);
    }

    return this.#state;
  }
}

export function getWorkspaceDurableObjectName(name: WorkspaceStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: name,
  });
}

function createPlainMethodObject(target: object): CloudflareShellState {
  const methods: CloudflareShellState = {};
  let prototype: object | null = Object.getPrototypeOf(target);

  while (prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || methods[name] !== undefined) continue;

      const value = (target as Record<string, unknown>)[name];
      if (typeof value === "function") {
        methods[name] = async (...args: unknown[]) => await value.apply(target, args);
      }
    }

    prototype = Object.getPrototypeOf(prototype);
  }

  return methods;
}
