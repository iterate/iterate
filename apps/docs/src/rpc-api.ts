import { RpcTarget } from "capnweb";
import type { RpcStub } from "capnweb";
import type { Project } from "iterate/client";
import {
  ProjectDial,
  projectCredentialAddress,
  readCookie,
  tokenClaims,
  type ProjectCredential,
} from "@iterate-com/workspace-documents/server";
import type {
  CollabAcceptResult,
  CollabChanges,
  CollabOpened,
  CollabWaitResult,
} from "@iterate-com/workspace-documents/types";
import type { AppEnv } from "./env.ts";
import type {
  DocsApi,
  DocsProject,
  DocsUser,
  DocsWorkspace,
  WorkspaceDocumentSnapshot,
} from "./lib/docs-api.ts";

const AUTH_COOKIE = "iterate-project-auth";

export class DocsApiRoot extends RpcTarget implements DocsApi {
  readonly #env: AppEnv;
  readonly #cookieToken: string | undefined;

  constructor(env: AppEnv, request: Request) {
    super();
    this.#env = env;
    this.#cookieToken = readCookie(request, AUTH_COOKIE);
  }

  async authenticate(credential?: string | ProjectCredential): Promise<DocsProject> {
    const resolved = this.#resolveCredential(credential);
    const dial = new ProjectDial(
      this.#env.OS_BASE_URL,
      projectCredentialAddress(resolved),
      resolved,
    );
    try {
      await dial.withProject((project) => project.identity());
    } catch (error) {
      dial.close();
      throw new Error(
        `authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new DocsProjectApi(dial, resolved);
  }

  #resolveCredential(credential?: string | ProjectCredential): ProjectCredential {
    if (typeof credential === "string") {
      const token = credential.trim();
      if (token === "") throw new Error("project-app-session token must not be empty");
      return { type: "project-app-session", token };
    }
    if (credential !== undefined) {
      if (credential.type === "project-app-session" && credential.token !== "") return credential;
      if (credential.type === "project-secret" && credential.secret !== "") {
        projectCredentialAddress(credential);
        return credential;
      }
      throw new Error("unsupported credential — expected project-app-session or project-secret");
    }
    if (this.#cookieToken !== undefined) {
      return { type: "project-app-session", token: this.#cookieToken };
    }
    throw new Error(
      "no credential — pass authenticate(token | {type, ...}) or send the iterate-project-auth cookie",
    );
  }
}

class DocsProjectApi extends RpcTarget implements DocsProject {
  readonly #dial: ProjectDial;
  readonly #credential: ProjectCredential;

  constructor(dial: ProjectDial, credential: ProjectCredential) {
    super();
    this.#dial = dial;
    this.#credential = credential;
  }

  async whoami(): Promise<DocsUser> {
    if (this.#credential.type !== "project-app-session") {
      return { email: null, image: null, name: null, userId: null };
    }
    const claims = tokenClaims(this.#credential.token);
    return {
      email: stringClaim(claims.email),
      image: stringClaim(claims.image),
      name: stringClaim(claims.name),
      userId: stringClaim(claims.userId),
    };
  }

  workspace(workspacePath: string): DocsWorkspace {
    return new DocsWorkspaceApi(this.#dial, requireWorkspacePath(workspacePath));
  }
}

class DocsWorkspaceApi extends RpcTarget implements DocsWorkspace {
  readonly #dial: ProjectDial;
  readonly #workspacePath: string;

  constructor(dial: ProjectDial, workspacePath: string) {
    super();
    this.#dial = dial;
    this.#workspacePath = workspacePath;
  }

  async inspect(rawPath: string): Promise<WorkspaceDocumentSnapshot> {
    const path = requireDocumentPath(rawPath);
    return this.#withWorkspace(async (workspace) => {
      const content = await workspace.readFile(path);
      if (content === null) {
        throw new Error(`document "${path}" does not exist in ${this.#workspacePath}`);
      }
      return {
        content,
        format: /\.html?$/i.test(path) ? "html" : "markdown",
        path,
        workspacePath: this.#workspacePath,
      };
    });
  }

  async open(rawPath: string): Promise<CollabOpened> {
    const path = requireDocumentPath(rawPath);
    return this.#withExistingDocument(path, (workspace) => workspace.collab.open(path));
  }

  async changes(rawPath: string): Promise<CollabChanges> {
    const path = requireDocumentPath(rawPath);
    return this.#withWorkspace((workspace) => workspace.collab.changes(path));
  }

  async push(input: {
    baseVersion: number;
    clientId: string;
    epoch: string;
    ops: { changes: unknown; clientSeq: number }[];
    path: string;
  }): Promise<CollabAcceptResult> {
    const path = requireDocumentPath(input.path);
    return this.#withWorkspace((workspace) => workspace.collab.push({ ...input, path }));
  }

  async wait(
    rawPath: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabWaitResult> {
    const path = requireDocumentPath(rawPath);
    return this.#withWorkspace((workspace) =>
      workspace.collab.wait(path, epoch, afterVersion, clientId, afterPresence),
    );
  }

  async present(
    rawPath: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): Promise<void> {
    const path = requireDocumentPath(rawPath);
    return this.#withWorkspace((workspace) => workspace.collab.present(path, clientId, selection));
  }

  async #withExistingDocument<T>(
    path: string,
    operation: (workspace: WorkspaceDocumentStub) => Promise<T>,
  ): Promise<T> {
    return this.#withWorkspace(async (workspace) => {
      if ((await workspace.readFile(path)) === null) {
        throw new Error(`document "${path}" does not exist in ${this.#workspacePath}`);
      }
      return operation(workspace);
    });
  }

  async #withWorkspace<T>(operation: (workspace: WorkspaceDocumentStub) => Promise<T>): Promise<T> {
    return this.#dial.withProject((project: RpcStub<Project>) => {
      // RpcStub maps discriminated-union promises distributively, which is
      // not assignable back to one Promise<union>. This local structural
      // surface describes the exact workspace methods Docs forwards.
      const workspaces = (
        project as unknown as {
          workspaces: { get(path: string): WorkspaceDocumentStub };
        }
      ).workspaces;
      return operation(workspaces.get(this.#workspacePath));
    });
  }
}

type WorkspaceDocumentStub = {
  readFile(path: string): Promise<string | null>;
  collab: {
    open(path: string): Promise<CollabOpened>;
    changes(path: string): Promise<CollabChanges>;
    push(input: {
      baseVersion: number;
      clientId: string;
      epoch: string;
      ops: { changes: unknown; clientSeq: number }[];
      path: string;
    }): Promise<CollabAcceptResult>;
    wait(
      path: string,
      epoch: string,
      afterVersion: number,
      clientId?: string,
      afterPresence?: number,
    ): Promise<CollabWaitResult>;
    present(
      path: string,
      clientId: string,
      selection: { anchor: number; head: number } | null,
    ): Promise<void>;
  };
};

export function requireWorkspacePath(value: string): string {
  return requireCanonicalPath(value, {
    description: "workspace path",
    prefix: "/workspaces/",
  });
}

export function requireDocumentPath(value: string): string {
  const path = requireCanonicalPath(value, {
    description: "document path",
    prefix: "/",
  });
  if (!/\.(?:html?|markdown|md)$/i.test(path)) {
    throw new Error("document path must end in .md, .markdown, .html, or .htm");
  }
  return path;
}

function requireCanonicalPath(
  value: string,
  options: { description: string; prefix: string },
): string {
  if (
    !value.startsWith(options.prefix) ||
    value.length > 2048 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.endsWith("/")
  ) {
    throw new Error(`invalid ${options.description}: ${JSON.stringify(value)}`);
  }
  const segments = value.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`invalid ${options.description}: ${JSON.stringify(value)}`);
  }
  return value;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
