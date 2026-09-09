import { RpcTarget } from "capnweb";
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
import {
  requireDocumentPath,
  requireWorkspaceFilePath,
  requireWorkspacePath,
} from "./config-bridge.ts";
import type { AppEnv } from "./env.ts";
import {
  BOARD_WORKSPACE_PREFIX,
  SCRATCH_WORKSPACE_PREFIX,
  isGuestWorkspacePath,
  newBoardId,
  normalizeRepoPath,
} from "./lib/board-shared.ts";
import { jamAgentPath, jamDocumentPath, jamInvitation, jamWorkspacePath } from "./lib/jam.ts";
import {
  parseTaskCard,
  setTaskCardAgent,
  setTaskCardState,
  taskAgentPath,
  taskAssignmentInstructions,
  taskColumnState,
} from "./tasks-model.ts";
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
  agents: { get(path: string): PlatformAgent };
  repos: { list(): Promise<{ path: string }[]> };
  streams: {
    get(path: string): {
      getEvents(args: object): Promise<unknown[]>;
      subscribe(args: object): Promise<unknown>;
    };
  };
  workspaces: {
    get(path: string): WorkspaceSurface & { create(input: object): Promise<unknown> };
    list(): Promise<{ createdAt: string; path: string }[]>;
  };
};

/** The agent surface the jam invite and the task assignment touch. */
type PlatformAgent = {
  create(): Promise<unknown>;
  message(text: string): Promise<unknown>;
  processor: { snapshot(): Promise<{ state?: { birthCertificate?: unknown } }> };
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

  async createWorkspace(
    input: { path?: string } = {},
  ): Promise<{ workspacePath: string; path: string | null }> {
    // An explicit path is a board under this app's own namespace — the only
    // caller-named workspaces this method creates; a scratch workspace wears
    // the human-readable stamp + random tail of a board id.
    const explicit = input.path === undefined ? null : requireWorkspacePath(input.path);
    if (explicit !== null && !explicit.startsWith(BOARD_WORKSPACE_PREFIX)) {
      throw new Error(`createWorkspace only names workspaces under ${BOARD_WORKSPACE_PREFIX}`);
    }
    const workspacePath = explicit ?? `${SCRATCH_WORKSPACE_PREFIX}${newBoardId()}`;
    const path = explicit === null ? "notes.md" : null;
    await this.#withPlatform(async (project) => {
      // Birth stays explicit (this is the app's ONE create call). Mounts are
      // not create's business: every project repo is derived onto its own
      // /repos/** path.
      const stub = project.workspaces.get(workspacePath);
      await stub.create({});
      // The document must EXIST before the editor opens it (no lazy file
      // create anywhere in Docs) — seed the starter note in the same breath.
      if (path !== null) await stub.writeFile(`${workspacePath}/${path}`, "# Notes\n\n");
    });
    return { workspacePath, path };
  }

  async createJam(): Promise<{ workspacePath: string; path: string }> {
    const id = newBoardId();
    const workspacePath = jamWorkspacePath(id);
    const path = jamDocumentPath(id);
    await this.#withPlatform(async (project) => {
      // Creates through the same workspace `create` call as createWorkspace.
      const stub = project.workspaces.get(workspacePath);
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
    const document = path === undefined ? null : resolveWorkspaceFilePath(workspace, path);
    // Same birth-if-needed sequence as assignAgent; the brief goes out every
    // time so a re-invite re-points an existing agent.
    await this.#withPlatform((project) =>
      briefAgent(project.agents.get(agentPath), jamInvitation(workspace, document)),
    );
    return { agentPath };
  }

  /**
   * Assign an agent to one task, the apps/os way: frontmatter first
   * (`state: in-progress` + `agent:`, visible to every collaborator through
   * the live workspace), then ONE commit so a born agent always finds its
   * durable assignment at HEAD, then birth-if-needed and the kickoff brief.
   * Commits the mount, so it is an owner act like commit itself.
   */
  async assignAgent(input: {
    workspacePath: string;
    repoPath: string;
    path: string;
  }): Promise<{ agentPath: string }> {
    const workspacePath = requireWorkspacePath(input.workspacePath);
    const repoPath = normalizeRepoPath(input.repoPath);
    if (repoPath === null) throw new Error("bad repo path");
    assertOwnerAct("assignAgent", workspacePath);
    const filePath = `${repoPath}/${input.path.replace(/^\/+/, "")}`;
    const source = await this.#withPlatform((project) =>
      project.workspaces.get(workspacePath).readFile(filePath),
    );
    if (source === null) throw new Error(`${input.path} does not exist in this workspace`);
    const card = parseTaskCard(input.path, source);
    if (card.agent !== null) return { agentPath: card.agent };
    const agentPath = taskAgentPath(repoPath, input.path);
    const staged =
      taskColumnState(card.state) === "in-progress"
        ? source
        : setTaskCardState(source, "in-progress");
    const content = setTaskCardAgent(staged, agentPath);
    await this.#withPlatform(async (project) => {
      const workspace = project.workspaces.get(workspacePath);
      await workspace.writeFile(filePath, content);
      await workspace.git.commit({ message: `Assign task: ${card.title}`, scope: repoPath });
    });
    await this.#withPlatform((project) =>
      briefAgent(project.agents.get(agentPath), taskAssignmentInstructions(repoPath, input.path)),
    );
    return { agentPath };
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
    this.#git = new WorkspaceGitApi(path, run);
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
   * commit, PUSHED over the retained callback — the platform's ephemeral
   * subscription composed end-to-end (browser stub → vessel → stream DO).
   * Returns the platform's subscription handle (unsubscribe()-able); the
   * assertion restates that handle's two members, which the capnweb-mapped
   * return type does not spell.
   */
  async subscribeEvents(
    processEventBatch: (batch: { events: WorkspaceStreamEvent[] }) => unknown,
    afterOffset = 0,
  ): Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }> {
    return this.#dial.withProject(
      async (project) =>
        (await (project as unknown as PlatformProject).streams.get(this.#path).subscribe({
          processEventBatch,
          replayAfterOffset: afterOffset,
        })) as { ping?(): Promise<boolean> | boolean; unsubscribe(): void },
    );
  }
}

/** `workspace.git`, forwarded — with the owner rule on commit. */
class WorkspaceGitApi extends RpcTarget implements WorkspaceGitSurface {
  readonly #workspacePath: string;
  readonly #run: WorkspaceRun;

  constructor(workspacePath: string, run: WorkspaceRun) {
    super();
    this.#workspacePath = workspacePath;
    this.#run = run;
  }

  status(): ReturnType<WorkspaceGitSurface["status"]> {
    return this.#run((workspace) => workspace.git.status());
  }

  commit(input: Parameters<WorkspaceGitSurface["commit"]>[0]) {
    assertOwnerAct("commit", this.#workspacePath);
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

  changes(path: string) {
    return this.#run((workspace) => workspace.collab.changes(path));
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

/**
 * Publishing is the workspace OWNER's act. This app owns only the
 * workspaces it mints itself (boards and scratch workspaces, shared by every
 * project member). Everything else is a guest view: it reads, comments, and
 * edits, but a commit would publish a mount's ENTIRE dirty set (the owning
 * agent's uncommitted work included), so the owner acts are refused here.
 */
function assertOwnerAct(operation: string, workspacePath: string): void {
  if (isGuestWorkspacePath(workspacePath)) {
    throw new Error(
      `${operation} is the workspace owner's act — this is a guest view on ${workspacePath}; ask the workspace's owner (its agent) to publish`,
    );
  }
}

/** Birth the agent if it has never been born, then send it the brief. */
async function briefAgent(agent: PlatformAgent, brief: string): Promise<void> {
  const snapshot = await agent.processor.snapshot();
  if ((snapshot.state?.birthCertificate ?? null) === null) await agent.create();
  await agent.message(brief);
}

/** Relative document paths join onto the workspace's own stream path; absolute paths are used verbatim. */
export function resolveDocumentPath(workspacePath: string, value: string): string {
  const path = requireDocumentPath(value);
  return path.startsWith("/") ? path : `${workspacePath}/${path}`;
}

/**
 * Any file of the workspace, not only a document (the tree opens every
 * file): relative joins onto the workspace's own directory, absolute must be
 * a fully qualified stream path under /workspaces/ or /repos/.
 */
export function resolveWorkspaceFilePath(workspacePath: string, value: string): string {
  const path = requireWorkspaceFilePath(value);
  return path.startsWith("/") ? path : `${workspacePath}/${path}`;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
