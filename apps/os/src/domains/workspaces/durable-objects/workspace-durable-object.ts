import { z } from "zod";
import { Workspace, WorkspaceFileSystem, createWorkspaceStateBackend } from "@cloudflare/shell";
import { createGit, type Git } from "@cloudflare/shell/git";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export type WorkspaceStructuredName = {
  projectId: string;
  workspaceId: string;
};

export type CloudflareShellState = import("@cloudflare/shell").StateBackend & {
  git: import("@cloudflare/shell/git").Git;
};

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

  async hasFile(path: string): Promise<boolean> {
    await this.ensureStarted();
    const state = this.getShellState();
    const readFile = state.readFile;
    if (typeof readFile !== "function") {
      throw new Error("Workspace state does not implement readFile.");
    }

    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isFileMissingError(error)) {
        return false;
      }

      throw error;
    }
  }

  async removePath(input: { force: boolean; path: string; recursive: boolean }): Promise<void> {
    await this.ensureStarted();
    const state = this.getShellState();
    const rm = state.rm;
    if (typeof rm !== "function") {
      throw new Error("Workspace state does not implement rm.");
    }

    await rm(input.path, {
      force: input.force,
      recursive: input.recursive,
    });
  }

  async writeFile(input: { content: string; path: string }): Promise<void> {
    await this.ensureStarted();
    const state = this.getShellState();
    const writeFile = state.writeFile;
    if (typeof writeFile !== "function") {
      throw new Error("Workspace state does not implement writeFile.");
    }

    await writeFile(input.path, input.content);
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
  const methods = {} as CloudflareShellState;
  let prototype: object | null = Object.getPrototypeOf(target);

  while (prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || methods[name as keyof CloudflareShellState] !== undefined)
        continue;

      const value = (target as Record<string, unknown>)[name];
      if (typeof value === "function") {
        Object.assign(methods, {
          [name]: async (...args: unknown[]) => await value.apply(target, args),
        });
      }
    }

    prototype = Object.getPrototypeOf(prototype);
  }

  return methods;
}

function isFileMissingError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("could not find") ||
    message.includes("no such file")
  );
}
