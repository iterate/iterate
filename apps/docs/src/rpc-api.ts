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
import { requireDocumentPath, requireWorkspacePath } from "./config-bridge.ts";
import type { AppEnv } from "./env.ts";
import { TasksWorkspaceApi } from "./tasks-rpc-api.ts";
import {
  DEFAULT_REPO_PATH,
  boardAddressFor,
  boardWorkspacePath,
  isBoardId,
  newBoardId,
  normalizeRepoPath,
} from "./lib/board-shared.ts";
import {
  isDocumentPath,
  jamAgentPath,
  jamDocumentPath,
  jamInvitation,
  jamWorkspacePath,
} from "./lib/jam.ts";
import type { TasksWorkspace, WorkspaceListEntry } from "./lib/tasks-api.ts";
import type {
  DocsApi,
  DocsProject,
  DocsUser,
  DocsWorkspace,
  WorkspaceDocumentSnapshot,
} from "./lib/docs-api.ts";

const AUTH_COOKIE = "iterate-project-auth";

/** The agent surface inviteAgent touches (the pinned `iterate` client types
 * predate it; capnweb stubs are Proxies, so the members resolve at runtime). */
type JamAgentStub = {
  create(): Promise<unknown>;
  message(text: string): Promise<unknown>;
  processor: { snapshot(): Promise<{ state?: { birthCertificate?: unknown } }> };
};

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
    let projectId: string;
    try {
      // Verify by use, and keep the canonical id: the cheap authenticated
      // identity read against the claimed project is the whole check.
      projectId = (await dial.withProject((project) => project.identity())).projectId;
    } catch (error) {
      dial.close();
      throw new Error(
        `authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new DocsProjectApi(dial, projectId, resolved);
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
  readonly #projectId: string;
  readonly #credential: ProjectCredential;

  constructor(dial: ProjectDial, projectId: string, credential: ProjectCredential) {
    super();
    this.#dial = dial;
    this.#projectId = projectId;
    this.#credential = credential;
  }

  async projectId(): Promise<string> {
    return this.#projectId;
  }

  /** The project's repo catalog — paths a board can be opened against. */
  async repos(): Promise<string[]> {
    const repos = (await this.#dial.withProject((project) => project.repos.list())) as Array<{
      path: string;
    }>;
    return repos.map((repo) => repo.path).sort();
  }

  /**
   * A board on the app's own workspace naming: the workspace path is derived
   * from (boardId, repoPath) and lazily created on first use — opening a
   * fresh board id IS how a new board workspace is born.
   */
  board(boardId: string, repoPath: string = DEFAULT_REPO_PATH): TasksWorkspace {
    const normalized = normalizeRepoPath(repoPath);
    if (!isBoardId(boardId) || normalized === null) {
      throw new Error("bad board id or repo path");
    }
    return new TasksWorkspaceApi(this.#dial, boardWorkspacePath(boardId, normalized), normalized, {
      lazyCreate: true,
    });
  }

  /**
   * A board lens on an EXISTING workspace, addressed by its platform path —
   * the same plain-`get` posture as workspace(): no lazy creation, no side
   * effects. Workspaces outside the app's own /workspaces/tasks/ namespace
   * are someone else's (an agent's, mid-thought): the capability serves
   * reads, comments, and edits there, but refuses the owner acts (commit,
   * assignAgent).
   */
  workspaceAt(workspacePath: string, repoPath: string = DEFAULT_REPO_PATH): TasksWorkspace {
    const normalized = normalizeRepoPath(repoPath);
    if (normalized === null) throw new Error("bad repo path");
    return new TasksWorkspaceApi(this.#dial, requireWorkspacePath(workspacePath), normalized, {
      lazyCreate: false,
    });
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

  async workspaces(): Promise<WorkspaceListEntry[]> {
    // The pinned iterate client types predate this surface; capnweb stubs
    // are Proxies, so the locally asserted members resolve at runtime — the
    // same convention as #withWorkspace below.
    const streams = (await this.#dial.withProject((project) => {
      const catalog = (
        project as unknown as {
          streams: { list(): Promise<{ createdAt: string; path: string }[]> };
        }
      ).streams;
      return catalog.list();
      // The platform's StreamListItem shape ({ path, createdAt }) — asserted
      // for the same pinned-client reason.
    })) as { createdAt: string; path: string }[];
    // The project's repos resolve board paths EXACTLY (a board path is
    // re-minted per repo and compared) — no guessing at the "--" separator.
    const repoPaths = await this.repos();
    // Ancestor pruning: every stream announces to every ancestor path, so a
    // nested workspace drags phantom ancestor streams into the catalog that
    // were never created as workspaces.
    const candidates = streams.filter((stream) => stream.path.startsWith("/workspaces/"));
    const paths = candidates.map((stream) => stream.path);
    const workspaces: WorkspaceListEntry[] = [];
    for (const stream of candidates) {
      if (paths.some((other) => other.startsWith(`${stream.path}/`))) continue;
      workspaces.push({
        path: stream.path,
        createdAt: stream.createdAt,
        board: boardAddressFor(stream.path, repoPaths),
      });
    }
    return workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async documents(workspacePath: string): Promise<string[]> {
    const workspace = requireWorkspacePath(workspacePath);
    return this.#dial.withProject(async (project) => {
      // Same pinned-client caveat as workspaces(): the glob member is part
      // of the platform workspace surface, asserted locally.
      const stub = (
        project as unknown as {
          workspaces: { get(path: string): { glob(pattern: string): Promise<string[]> } };
        }
      ).workspaces.get(workspace);
      // ONE tree walk, filtered here to every extension requireDocumentPath
      // accepts (no more and no less) — the platform glob enumerates the
      // whole tree per pattern, so four extension globs cost four walks.
      const everything = await stub.glob(`${workspace}/**/*`);
      const documents: string[] = [];
      for (const path of everything) {
        const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
        if (
          extension === "md" ||
          extension === "markdown" ||
          extension === "html" ||
          extension === "htm"
        ) {
          documents.push(path.slice(workspace.length + 1));
        }
      }
      return documents.sort((left, right) => left.localeCompare(right)).slice(0, 200);
    });
  }

  async createWorkspace(): Promise<{ workspacePath: string; path: string }> {
    // Human-readable stamp + random tail, the tasks board-id recipe.
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
    const workspacePath = `/workspaces/scratch/${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const path = "notes.md";
    await this.#dial.withProject(async (project) => {
      // Same pinned-client caveat as workspaces(): create/writeFile are the
      // platform workspace surface, asserted locally; birth stays explicit
      // (this is the app's ONE create door).
      const stub = (
        project as unknown as {
          workspaces: {
            get(path: string): {
              create(input: object): Promise<unknown>;
              writeFile(path: string, content: string): Promise<void>;
            };
          };
        }
      ).workspaces.get(workspacePath);
      await stub.create({});
      // The document must EXIST before the editor opens it (no lazy file
      // create anywhere in Docs) — seed the starter note in the same breath.
      await stub.writeFile(`${workspacePath}/${path}`, "# Notes\n\n");
    });
    return { workspacePath, path };
  }

  async documentsUnder(workspacePath: string, repoPath: string): Promise<string[]> {
    const workspace = requireWorkspacePath(workspacePath);
    const mount = normalizeRepoPath(repoPath);
    if (mount === null) throw new Error("bad repo path");
    return this.#dial.withProject(async (project) => {
      const stub = (
        project as unknown as {
          workspaces: { get(path: string): { glob(pattern: string): Promise<string[]> } };
        }
      ).workspaces.get(workspace);
      // One tree walk of the mount (the merged view: overlay over the repo
      // at HEAD), filtered here to what the editor can open.
      const everything = await stub.glob(`${mount}/**/*`);
      return everything
        .filter(isDocumentPath)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 500);
    });
  }

  async createJam(): Promise<{ workspacePath: string; path: string }> {
    const id = newBoardId();
    const workspacePath = jamWorkspacePath(id);
    const path = jamDocumentPath(id);
    await this.#dial.withProject(async (project) => {
      // Same create door and pinned-client caveat as createWorkspace.
      const stub = (
        project as unknown as {
          workspaces: {
            get(path: string): {
              create(input: object): Promise<unknown>;
              writeFile(path: string, content: string): Promise<void>;
            };
          };
        }
      ).workspaces.get(workspacePath);
      await stub.create({});
      await stub.writeFile(path, `# Jam ${id}\n\n`);
    });
    return { workspacePath, path };
  }

  async inviteAgent(workspacePath: string, path?: string): Promise<{ agentPath: string }> {
    const workspace = requireWorkspacePath(workspacePath);
    const agentPath = jamAgentPath(workspace);
    if (agentPath === null) {
      throw new Error(`only a jam workspace can invite an agent; ${workspace} is not one`);
    }
    const document = path === undefined ? null : resolveDocumentPath(workspace, path);
    await this.#dial.withProject(async (project) => {
      // Same birth-if-needed dance as the board's assignAgent; the brief
      // goes out every time so a re-invite re-points an existing agent.
      const agent = (
        project as unknown as { agents: { get(path: string): JamAgentStub } }
      ).agents.get(agentPath);
      const snapshot = await agent.processor.snapshot();
      if ((snapshot.state?.birthCertificate ?? null) === null) await agent.create();
      await agent.message(jamInvitation(workspace, document));
    });
    return { agentPath };
  }

  /** Release the downstream OS session when Cap'n Web drops this project capability. */
  [Symbol.dispose](): void {
    this.#dial.close();
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
    const path = resolveDocumentPath(this.#workspacePath, rawPath);
    return this.#withWorkspace(async (workspace) => {
      const content = await workspace.readFile(path);
      if (content === null) {
        throw new Error(`document "${path}" does not exist`);
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
    const path = resolveDocumentPath(this.#workspacePath, rawPath);
    return this.#withExistingDocument(path, (workspace) => workspace.collab.open(path));
  }

  async changes(rawPath: string): Promise<CollabChanges> {
    const path = resolveDocumentPath(this.#workspacePath, rawPath);
    return this.#withWorkspace((workspace) => workspace.collab.changes(path));
  }

  async push(input: {
    baseVersion: number;
    clientId: string;
    epoch: string;
    ops: { changes: unknown; clientSeq: number }[];
    path: string;
  }): Promise<CollabAcceptResult> {
    const path = resolveDocumentPath(this.#workspacePath, input.path);
    return this.#withWorkspace((workspace) => workspace.collab.push({ ...input, path }));
  }

  async wait(
    rawPath: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabWaitResult> {
    const path = resolveDocumentPath(this.#workspacePath, rawPath);
    return this.#withWorkspace((workspace) =>
      workspace.collab.wait(path, epoch, afterVersion, clientId, afterPresence),
    );
  }

  async present(
    rawPath: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): Promise<void> {
    const path = resolveDocumentPath(this.#workspacePath, rawPath);
    return this.#withWorkspace((workspace) => workspace.collab.present(path, clientId, selection));
  }

  async #withExistingDocument<T>(
    path: string,
    operation: (workspace: WorkspaceDocumentStub) => Promise<T>,
  ): Promise<T> {
    return this.#withWorkspace(async (workspace) => {
      if ((await workspace.readFile(path)) === null) {
        throw new Error(`document "${path}" does not exist`);
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

/** Relative document paths join onto the workspace's own stream path; absolute paths are used verbatim. */
export function resolveDocumentPath(workspacePath: string, value: string): string {
  const path = requireDocumentPath(value);
  return path.startsWith("/") ? path : `${workspacePath}/${path}`;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
