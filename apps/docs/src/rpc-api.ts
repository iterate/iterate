import { RpcTarget } from "capnweb";
import type { Agent } from "iterate/client";
import {
  ProjectDial,
  projectCredentialAddress,
  readCookie,
  tokenClaims,
  type ProjectCredential,
} from "@iterate-com/workspace-documents/server";
import type {
  WorkspaceCollabSurface,
  WorkspaceGitSurface,
  WorkspaceSurface,
} from "@iterate-com/workspace-documents/types";
import { requireDocumentPath, requireWorkspacePath } from "./config-bridge.ts";
import type { AppEnv } from "./env.ts";
import type {
  DocsApi,
  DocsProject,
  DocsUser,
  DocsWorkspace,
  WorkspaceListEntry,
  WorkspaceStreamEvent,
} from "./lib/docs-api.ts";

const AUTH_COOKIE = "iterate-project-auth";

/**
 * The platform itx members this vessel touches, asserted locally: the
 * generated `Project` client type carries the project's own methods, not the
 * capability tree, and capnweb stubs are Proxies, so these members resolve
 * at runtime. The workspace handle IS the shared WorkspaceSurface plus the
 * one lifecycle method (create) the vessel creates workspaces through. Every
 * `project as unknown as PlatformProject` below is this same fact — the
 * generated type has no `workspaces`/`streams`/`agents` members to narrow
 * from, so a cast-free spelling does not exist.
 */
type PlatformProject = {
  agents: { get(path: string): Agent };
  repos: { list(): Promise<{ path: string }[]> };
  streams: {
    get(path: string): {
      getEvents(args: object): Promise<unknown[]>;
      openConnection(args: object): Promise<{ ping(): boolean | Promise<boolean>; close(): void }>;
    };
  };
  workspaces: {
    get(path: string): WorkspaceSurface & { create(input: object): Promise<unknown> };
    list(): Promise<{ createdAt: string; path: string }[]>;
  };
};

/** Reconnect-aware access to one workspace's platform handle. */
type WorkspaceRun = <T>(operation: (workspace: WorkspaceSurface) => Promise<T>) => Promise<T>;

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

  #withPlatform<T>(operation: (project: PlatformProject) => Promise<T>): Promise<T> {
    return this.#dial.withProject((project) => operation(project as unknown as PlatformProject));
  }

  async projectId(): Promise<string> {
    return this.#projectId;
  }

  /** The project's repo catalog — paths a board can be opened against. */
  async repos(): Promise<string[]> {
    const repos = await this.#withPlatform((project) => project.repos.list());
    return repos.map((repo) => repo.path).sort();
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
    const path = requireWorkspacePath(workspacePath);
    return new WorkspaceApi(this.#dial, path, (operation) =>
      this.#withPlatform((project) => operation(project.workspaces.get(path))),
    );
  }

  async workspaces(): Promise<WorkspaceListEntry[]> {
    const workspaces = await this.#withPlatform((project) => project.workspaces.list());
    return workspaces
      .map((workspace) => ({ path: workspace.path, createdAt: workspace.createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createWorkspace(input: { path: string }): Promise<{ workspacePath: string }> {
    const workspacePath = requireWorkspacePath(input.path);
    // Birth stays explicit (this is the app's ONE create call). Mounts are
    // not create's business: every project repo is derived onto its own
    // /repos/** path. The platform's agent-path rule (lowercase segments
    // under /agents/) is the only naming rule, applied when the feed pane
    // births the agent on the same stream.
    await this.#withPlatform((project) => project.workspaces.get(workspacePath).create({}));
    return { workspacePath };
  }

  /**
   * The agent sharing this workspace's path, forwarded as the platform's own
   * handle: Cap'n Web exports the stub it received from OS to the browser
   * and proxies every call through this vessel. Plain get — birth is the
   * caller's explicit `create()`.
   */
  agent(workspacePath: string): Promise<Agent> {
    const path = requireWorkspacePath(workspacePath);
    return this.#withPlatform(async (project) => project.agents.get(path));
  }

  /** Release the downstream OS session when Cap'n Web drops this project capability. */
  [Symbol.dispose](): void {
    this.#dial.close();
  }
}

/**
 * One workspace, forwarded verbatim: the platform's fs surface here, its git
 * and collab surfaces as sub-targets, and the workspace's stream. Stateless
 * beyond the dial — versions, epochs, and the overlay all live in the
 * workspace DO; live sessions settle inside the workspace's own barriers.
 */
class WorkspaceApi extends RpcTarget implements DocsWorkspace {
  readonly #dial: ProjectDial;
  readonly #path: string;
  readonly #run: WorkspaceRun;
  readonly #git: WorkspaceGitApi;
  readonly #collab: WorkspaceCollabApi;

  constructor(dial: ProjectDial, path: string, run: WorkspaceRun) {
    super();
    this.#dial = dial;
    this.#path = path;
    this.#run = run;
    this.#git = new WorkspaceGitApi(run);
    this.#collab = new WorkspaceCollabApi(run);
  }

  get git(): WorkspaceGitApi {
    return this.#git;
  }

  get collab(): WorkspaceCollabApi {
    return this.#collab;
  }

  readFile(path: string): Promise<string | null> {
    return this.#run((workspace) => workspace.readFile(path));
  }

  readFiles(paths: string[]): Promise<Record<string, string | null>> {
    return this.#run((workspace) => workspace.readFiles(paths));
  }

  readBase(path: string): Promise<string | null> {
    return this.#run((workspace) => workspace.readBase(path));
  }

  exists(path: string): Promise<boolean> {
    return this.#run((workspace) => workspace.exists(path));
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.#run((workspace) => workspace.writeFile(path, content));
  }

  deleteFile(path: string): Promise<boolean> {
    return this.#run((workspace) => workspace.deleteFile(path));
  }

  revert(path: string): Promise<void> {
    return this.#run((workspace) => workspace.revert(path));
  }

  listAllFiles(): Promise<string[]> {
    return this.#run((workspace) => workspace.listAllFiles());
  }

  glob(pattern: string): Promise<string[]> {
    return this.#run((workspace) => workspace.glob(pattern));
  }

  /** The newest page of the workspace's stream events, newest first. */
  async events(limit = 50): Promise<WorkspaceStreamEvent[]> {
    // The platform's StreamEvent shape, restated for the four fields read
    // below: the pinned client's getEvents returns the capnweb-mapped type,
    // which does not assign to a plain array type without this assertion.
    const events = (await this.#dial.withProject((project) =>
      (project as unknown as PlatformProject).streams
        .get(this.#path)
        .getEvents({ includeEphemeral: true }),
    )) as { createdAt?: string; offset: number; payload?: unknown; type: string }[];
    return events
      .slice(-limit)
      .reverse()
      .map((event) => ({
        createdAt: event.createdAt ?? "",
        offset: event.offset,
        payload: event.payload ?? null,
        type: event.type,
      }));
  }

  /**
   * Live event feed: durable history after `afterOffset`, then every new
   * commit, PUSHED over the retained callback — the platform's session
   * connection composed end-to-end (browser stub → vessel → stream DO).
   * The platform's connection handle is `close()`-able; this restates it in
   * the two members the browser's connection loop drives.
   */
  async subscribeEvents(
    processEventBatch: (batch: { events: WorkspaceStreamEvent[] }) => unknown,
    afterOffset = 0,
  ): Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }> {
    return this.#dial.withProject(async (project) => {
      // The dialed stub is the full project capability tree at runtime; the
      // generated Project type omits `streams` (see PlatformProject above).
      const connection = await (project as unknown as PlatformProject).streams
        .get(this.#path)
        .openConnection({ processEventBatch, replayAfterOffset: afterOffset });
      return { ping: () => connection.ping(), unsubscribe: () => connection.close() };
    });
  }
}

/** `workspace.git`, forwarded. */
class WorkspaceGitApi extends RpcTarget implements WorkspaceGitSurface {
  readonly #run: WorkspaceRun;

  constructor(run: WorkspaceRun) {
    super();
    this.#run = run;
  }

  status(): ReturnType<WorkspaceGitSurface["status"]> {
    return this.#run((workspace) => workspace.git.status());
  }

  commit(input: Parameters<WorkspaceGitSurface["commit"]>[0]) {
    return this.#run((workspace) => workspace.git.commit(input));
  }

  log(input?: Parameters<WorkspaceGitSurface["log"]>[0]) {
    return this.#run((workspace) => workspace.git.log(input));
  }
}

/** `workspace.collab`, forwarded verbatim. */
class WorkspaceCollabApi extends RpcTarget implements WorkspaceCollabSurface {
  readonly #run: WorkspaceRun;

  constructor(run: WorkspaceRun) {
    super();
    this.#run = run;
  }

  open(path: string) {
    return this.#run((workspace) => workspace.collab.open(path));
  }

  push(input: Parameters<WorkspaceCollabSurface["push"]>[0]) {
    return this.#run((workspace) => workspace.collab.push(input));
  }

  wait(
    path: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ) {
    return this.#run((workspace) =>
      workspace.collab.wait(path, epoch, afterVersion, clientId, afterPresence),
    );
  }

  present(path: string, clientId: string, selection: { anchor: number; head: number } | null) {
    return this.#run((workspace) => workspace.collab.present(path, clientId, selection));
  }

  versions() {
    return this.#run((workspace) => workspace.collab.versions());
  }

  presenceSummary() {
    return this.#run((workspace) => workspace.collab.presenceSummary());
  }

  boardViewers() {
    return this.#run((workspace) => workspace.collab.boardViewers());
  }

  boardPresent(clientId: string, name: string | null) {
    return this.#run((workspace) => workspace.collab.boardPresent(clientId, name));
  }
}

/** Relative document paths join onto /workspace; absolute paths are used verbatim. */
export function resolveDocumentPath(value: string): string {
  const path = requireDocumentPath(value);
  return path.startsWith("/") ? path : `/workspace/${path}`;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
