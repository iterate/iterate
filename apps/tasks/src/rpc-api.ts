import { RpcTarget } from "capnweb";
import { getServerByName } from "partyserver";
import {
  ProjectDial,
  projectCredentialAddress,
  readCookie,
  tokenClaims,
} from "@iterate-com/workspace-documents/server";
import type { AppEnv } from "./env.ts";
import type { CommitResult, TaskChangeSummary } from "./state.ts";
import type {
  CheckoutIndexEntry,
  CheckoutSnapshot,
  CollabAcceptResult,
  CollabChanges,
  CollabOpened,
  CollabWaitResult,
  ProjectCredential,
  WorkspaceStreamEvent,
  TasksApi,
  TasksCheckout,
  TasksProject,
  TasksUser,
  TasksWorkspace,
} from "./lib/tasks-api.ts";
import { DEFAULT_REPO_PATH, isCheckoutId, normalizeRepoPath } from "./lib/checkout-shared.ts";

const AUTH_COOKIE = "iterate-project-auth";

/**
 * The checkout DO's plain-data RPC surface (native workerd RPC on the stub —
 * a capnweb stub is a Proxy and cannot cross this hop, so only strings and
 * JSON shapes do; per-user platform access travels as the token itself).
 */
type CheckoutStubOps = {
  ensureSeeded(credential: ProjectCredential, projectId: string, repoPath: string): Promise<void>;
  filesSnapshot(): Promise<CheckoutSnapshot>;
  readFile(path: string): Promise<string | null>;
  applyWrite(path: string, content: string | null): Promise<void>;
  changesSummary(): Promise<TaskChangeSummary[]>;
  commitDoc(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
    message: string,
  ): Promise<CommitResult>;
  generateMessageDoc(credential: ProjectCredential, projectId: string): Promise<string>;
  assignAgentDoc(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
    taskPath: string,
  ): Promise<{ agentPath: string }>;
};

/**
 * The capability handed to every connection on `/api` — one method,
 * `authenticate`, which proves a project-app-session token by USING it
 * against the platform and returns the project-scoped API. Browsers rely on
 * the proxy-stamped cookie; agents and other services pass the token
 * explicitly. Either way the token's own projectId claim decides which
 * project this session is — the dial fails if the claim is a lie.
 */
export class TasksApiRoot extends RpcTarget implements TasksApi {
  readonly #env: AppEnv;
  readonly #cookieToken: string | undefined;

  constructor(env: AppEnv, request: Request) {
    super();
    this.#env = env;
    this.#cookieToken = readCookie(request, AUTH_COOKIE);
  }

  async authenticate(credential?: string | ProjectCredential): Promise<TasksProject> {
    const resolved = this.#resolve(credential);
    const dial = new ProjectDial(
      this.#env.OS_BASE_URL,
      projectCredentialAddress(resolved),
      resolved,
    );
    let projectId: string;
    try {
      // Verify by use: the vessel keeps no secrets, so a cheap authenticated
      // identity read against the claimed project is the whole check. Keep
      // the canonical id for Durable Object names even when the caller used
      // the preferred slug-addressed project-secret.
      projectId = (await dial.withProject((project) => project.identity())).projectId;
    } catch (error) {
      dial.close();
      throw new Error(`authentication failed: ${errorText(error)}`);
    }
    return new TasksProjectApi(this.#env, dial, projectId, resolved);
  }

  #resolve(credential?: string | ProjectCredential): ProjectCredential {
    if (typeof credential === "string" && credential.trim() !== "") {
      return { type: "project-app-session", token: credential.trim() };
    }
    if (credential !== undefined && typeof credential === "object" && credential !== null) {
      if (credential.type === "project-app-session" && credential.token) return credential;
      if (credential.type === "project-secret" && credential.secret) {
        projectCredentialAddress(credential);
        return credential;
      }
      throw new Error("unsupported credential — expected project-app-session or project-secret");
    }
    if (this.#cookieToken) return { type: "project-app-session", token: this.#cookieToken };
    throw new Error(
      "no credential — pass authenticate(token | {type, ...}) or send the iterate-project-auth cookie",
    );
  }
}

class TasksProjectApi extends RpcTarget implements TasksProject {
  readonly #env: AppEnv;
  readonly #dial: ProjectDial;
  readonly #projectId: string;
  readonly #credential: ProjectCredential;

  constructor(env: AppEnv, dial: ProjectDial, projectId: string, credential: ProjectCredential) {
    super();
    this.#env = env;
    this.#dial = dial;
    this.#projectId = projectId;
    this.#credential = credential;
  }

  async projectId(): Promise<string> {
    return this.#projectId;
  }

  async whoami(): Promise<TasksUser> {
    if (this.#credential.type !== "project-app-session") {
      return { userId: null, email: null, name: null, image: null };
    }
    // The claims are trustworthy here: authenticate() already proved this
    // exact token by using it against the platform.
    const claims = tokenClaims(this.#credential.token);
    return {
      userId: typeof claims.userId === "string" ? claims.userId : null,
      email: typeof claims.email === "string" ? claims.email : null,
      name: typeof claims.name === "string" ? claims.name : null,
      image: typeof claims.image === "string" ? claims.image : null,
    };
  }

  async repos(): Promise<string[]> {
    const repos = (await this.#dial.withProject((project) => project.repos.list())) as Array<{
      path: string;
    }>;
    return repos.map((repo) => repo.path).sort();
  }

  async checkouts(): Promise<CheckoutIndexEntry[]> {
    return this.#env.INDEX.getByName(this.#projectId).list();
  }

  checkout(checkoutId: string, repoPath: string = DEFAULT_REPO_PATH): TasksCheckout {
    const normalized = normalizeRepoPath(repoPath);
    if (!isCheckoutId(checkoutId) || normalized === null) {
      throw new Error("bad checkout id or repo path");
    }
    return new TasksCheckoutApi(
      this.#env,
      this.#projectId,
      this.#credential,
      checkoutId,
      normalized,
    );
  }

  /**
   * The checkout AS a platform workspace (PoC hop (a): browser → vessel
   * `/api` → workspace DO). Every project repo is auto-mounted at its own
   * `/repos/**` path; this capability scopes itself to ONE of them — it is
   * the single place board-lane repo-relative paths meet the mount prefix.
   * Created lazily on first use; one capability carries both the collab
   * session lane and the board lane.
   */
  workspace(checkoutId: string, repoPath: string = DEFAULT_REPO_PATH): TasksWorkspaceApi {
    const normalized = normalizeRepoPath(repoPath);
    if (!isCheckoutId(checkoutId) || normalized === null) {
      throw new Error("bad checkout id or repo path");
    }
    return new TasksWorkspaceApi(this.#env, this.#projectId, this.#dial, checkoutId, normalized);
  }

  [Symbol.dispose](): void {
    this.#dial.close();
  }
}

/**
 * One checkout, as a capability. Every method lazily makes sure the DO is
 * seeded first (agents may reach a checkout before any browser has), then
 * forwards to the DO's plain-data RPC methods — mutations land in the live
 * Y.Doc, so connected collaborators see agent edits keystroke-for-keystroke
 * with their own.
 */
class TasksCheckoutApi extends RpcTarget implements TasksCheckout {
  readonly #env: AppEnv;
  readonly #projectId: string;
  readonly #credential: ProjectCredential;
  readonly #checkoutId: string;
  readonly #repoPath: string;
  #stub: Promise<CheckoutStubOps> | null = null;
  #seeded: Promise<void> | null = null;

  constructor(
    env: AppEnv,
    projectId: string,
    credential: ProjectCredential,
    checkoutId: string,
    repoPath: string,
  ) {
    super();
    this.#env = env;
    this.#projectId = projectId;
    this.#credential = credential;
    this.#checkoutId = checkoutId;
    this.#repoPath = repoPath;
  }

  async files(): Promise<CheckoutSnapshot> {
    return (await this.#ready()).filesSnapshot();
  }

  async read(path: string): Promise<string | null> {
    return (await this.#ready()).readFile(path);
  }

  async write(path: string, content: string): Promise<void> {
    return (await this.#ready()).applyWrite(path, content);
  }

  async delete(path: string): Promise<void> {
    return (await this.#ready()).applyWrite(path, null);
  }

  async changes(): Promise<TaskChangeSummary[]> {
    return (await this.#ready()).changesSummary();
  }

  async commit(message: string): Promise<CommitResult> {
    const stub = await this.#ready();
    return stub.commitDoc(this.#credential, this.#projectId, this.#repoPath, message);
  }

  async generateMessage(): Promise<string> {
    const stub = await this.#ready();
    return stub.generateMessageDoc(this.#credential, this.#projectId);
  }

  async assignAgent(path: string): Promise<{ agentPath: string }> {
    const stub = await this.#ready();
    return stub.assignAgentDoc(this.#credential, this.#projectId, this.#repoPath, path);
  }

  #do(): Promise<CheckoutStubOps> {
    // getServerByName (not plain getByName) so partyserver's onStart — which
    // loads the persisted doc — has completed before any method runs.
    this.#stub ??= getServerByName(
      this.#env.CHECKOUT as unknown as Parameters<typeof getServerByName>[0],
      `${this.#projectId}:${this.#repoPath}:${this.#checkoutId}`,
    ).then((stub) => stub as unknown as CheckoutStubOps);
    return this.#stub;
  }

  async #ready(): Promise<CheckoutStubOps> {
    const stub = await this.#do();
    if (this.#seeded === null) {
      this.#seeded = stub
        .ensureSeeded(this.#credential, this.#projectId, this.#repoPath)
        .catch((error: unknown) => {
          this.#seeded = null;
          throw error;
        });
    }
    await this.#seeded;
    return stub;
  }
}

/** The platform workspace surface this vessel forwards to. The pinned
 * `iterate` client types predate it, so the shape is asserted locally —
 * capnweb stubs are Proxies, so unknown properties resolve at runtime. */
type WorkspaceStub = {
  // Mounts are not create's business: every project repo is derived onto its
  // own /repos/** path, and mounting at "/" is rejected.
  create(input: object): Promise<unknown>;
  collab: {
    open(path: string): Promise<CollabOpened>;
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
    changes(path: string): Promise<CollabChanges>;
    versions(): Promise<Record<string, number>>;
    presenceSummary(): Promise<{ clientIds: string[]; paths: string[] }>;
    boardViewers(): Promise<Record<string, string>>;
    boardPresent(clientId: string, name: string | null): Promise<void>;
  };
  readBase(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  glob(pattern: string): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  readFiles(paths: string[]): Promise<Record<string, string | null>>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<boolean>;
  revert(path: string): Promise<void>;
  git: {
    status(): Promise<unknown>;
    // scope names the mount to operate on — required in practice now that
    // every project repo is a mount (log always, commit whenever >1 dirty).
    commit(input: { message: string; scope: string }): Promise<unknown>;
    log(input: { limit?: number; scope: string }): Promise<unknown>;
  };
};

/**
 * The checkout AS a platform workspace, forwarded over the vessel's live
 * dial. Stateless beyond the dial (versions/epochs live in the workspace DO),
 * lazily created on first use, and carrying both lanes: the collaborative
 * session wire and the board (files/status/commit — the overlay IS the diff,
 * no base snapshot anywhere; live sessions settle inside the workspace's own
 * barriers).
 *
 * Path contract: the collab lane (open/push/wait/present/changes) speaks
 * fully qualified `/repos/**` paths — a session's identity is its platform
 * path, shared with agents. Every other path crosses this class repo-relative
 * (leading slash optional); #qualified/#repoRelative are the ONLY join between
 * board keys and the mount prefix.
 */
class TasksWorkspaceApi extends RpcTarget implements TasksWorkspace {
  readonly #env: AppEnv;
  readonly #projectId: string;
  readonly #dial: ProjectDial;
  readonly #checkoutId: string;
  readonly #repoPath: string;
  #created = false;
  #indexed = false;

  constructor(
    env: AppEnv,
    projectId: string,
    dial: ProjectDial,
    checkoutId: string,
    repoPath: string,
  ) {
    super();
    this.#env = env;
    this.#projectId = projectId;
    this.#dial = dial;
    this.#checkoutId = checkoutId;
    this.#repoPath = repoPath;
  }

  /**
   * The sidebar and home page list checkouts from the index DO — a checkout
   * that never announces itself does not exist for navigation. Announce on
   * first successful use (once per capability) and on every commit (bumps
   * recency + records the commit). Fire-and-forget: the index is a
   * convenience surface and must never fail a real operation.
   */
  #announce(baseCommit?: string): void {
    if (baseCommit === undefined) {
      if (this.#indexed) return;
      this.#indexed = true;
    }
    void this.#env.INDEX.getByName(this.#projectId)
      .record({ repoPath: this.#repoPath, checkoutId: this.#checkoutId, baseCommit })
      .catch(() => undefined);
  }

  get #workspacePath(): string {
    const repoSlug = this.#repoPath.replace(/^\/+/, "").replaceAll("/", "--");
    return `/workspaces/tasks/${this.#checkoutId}~${repoSlug}`;
  }

  /** Board-lane paths → the platform's mount-qualified form. */
  #qualified(path: string): string {
    return `${this.#repoPath}/${path.replace(/^\/+/, "")}`;
  }

  /** Inverse of #qualified, and the visibility filter: platform paths
   * outside this capability's repo mount return null. */
  #repoRelative(path: string): string | null {
    const prefix = `${this.#repoPath}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  }

  async #withWorkspace<T>(operation: (ws: WorkspaceStub) => Promise<T>): Promise<T> {
    return this.#dial.withProject(async (project) => {
      const workspaces = (
        project as unknown as { workspaces: { get(path: string): WorkspaceStub } }
      ).workspaces;
      // The workspace identity ENCODES the repo: the same checkout id against
      // a different repository is a different workspace — it can never
      // silently bind to (and edit) the first repository's workspace.
      const ws = workspaces.get(this.#workspacePath);
      try {
        const result = await operation(ws);
        this.#announce();
        return result;
      } catch (error) {
        // Only the workspace-missing error (exact platform phrasing) triggers
        // lazy creation — a file-level "does not exist" must surface as-is.
        if (this.#created || !/workspace "[^"]+" does not exist/.test(errorText(error))) {
          throw error;
        }
        // Concurrent first-touchers may race create: tolerate its failure and
        // retry the operation regardless — ITS error is the one that matters.
        // The repo mount is not passed: creation derives every project repo
        // onto its own /repos/** path.
        await ws.create({}).catch(() => undefined);
        // Proven by USE: only a successful retry marks the workspace created —
        // a transient create failure must not wedge this held capability.
        const result = await operation(ws);
        this.#created = true;
        this.#announce();
        return result;
      }
    });
  }

  open(filePath: string): Promise<CollabOpened> {
    return this.#withWorkspace((ws) => ws.collab.open(filePath));
  }

  readBase(filePath: string): Promise<string | null> {
    return this.#withWorkspace((ws) => ws.readBase(this.#qualified(filePath)));
  }

  changes(filePath: string): Promise<CollabChanges> {
    return this.#withWorkspace((ws) => ws.collab.changes(filePath));
  }

  push(input: {
    baseVersion: number;
    clientId: string;
    epoch: string;
    ops: { changes: unknown; clientSeq: number }[];
    path: string;
  }): Promise<CollabAcceptResult> {
    return this.#withWorkspace((ws) => ws.collab.push(input));
  }

  wait(
    filePath: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabWaitResult> {
    return this.#withWorkspace((ws) =>
      ws.collab.wait(filePath, epoch, afterVersion, clientId, afterPresence),
    );
  }

  present(
    filePath: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): Promise<void> {
    return this.#withWorkspace((ws) => ws.collab.present(filePath, clientId, selection));
  }

  versions(): Promise<Record<string, number>> {
    // Sessions are keyed by their fully qualified platform paths; the board's
    // change cursor wants repo-relative keys, and sessions under other repos'
    // mounts are invisible through this capability.
    return this.#withWorkspace(async (ws) => {
      const versions = await ws.collab.versions();
      return Object.fromEntries(
        Object.entries(versions).flatMap(([path, version]) => {
          const key = this.#repoRelative(path);
          return key === null ? [] : [[key, version]];
        }),
      );
    });
  }

  async presenceSummary(): Promise<Record<string, string[]>> {
    // The platform hop speaks index-matched flat arrays (generator-legal);
    // the browser keeps the natural Record shape, keyed repo-relative like
    // versions() — carets in other repos' mounts stay out of this board.
    const flat = await this.#withWorkspace((ws) => ws.collab.presenceSummary());
    const summary: Record<string, string[]> = {};
    flat.paths.forEach((path, index) => {
      const clientId = flat.clientIds[index];
      const key = this.#repoRelative(path);
      if (clientId !== undefined && key !== null) (summary[key] ??= []).push(clientId);
    });
    return summary;
  }

  boardViewers(): Promise<Record<string, string>> {
    return this.#withWorkspace((ws) => ws.collab.boardViewers());
  }

  boardPresent(clientId: string, name: string | null): Promise<void> {
    return this.#withWorkspace((ws) => ws.collab.boardPresent(clientId, name));
  }

  /** The newest page of the workspace's stream events, newest first. */
  async events(limit = 50): Promise<WorkspaceStreamEvent[]> {
    // A REAL workspace call: on a fresh checkout it throws the
    // missing-workspace error, which is what makes #withWorkspace lazily
    // create it — so the stream (and its birth events) exist to read.
    // Probed at the repo mount: "/" is no path in any workspace now.
    await this.#withWorkspace((ws) => ws.exists(this.#repoPath));
    const events = (await this.#dial.withProject(async (project) => {
      const streams = (
        project as unknown as {
          streams: { get(path: string): { getEvents(args: object): Promise<unknown[]> } };
        }
      ).streams;
      return streams.get(this.#workspacePath).getEvents({ includeEphemeral: true });
    })) as { createdAt?: string; offset: number; payload?: unknown; type: string }[];
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
   * subscription lane composed end-to-end (browser stub → vessel → stream
   * DO). Returns the platform's subscription handle (unsubscribe()-able).
   */
  async subscribeEvents(
    processEventBatch: (batch: { events: WorkspaceStreamEvent[] }) => unknown,
    afterOffset = 0,
  ): Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }> {
    // A real call (see events()) so lazy creation actually runs.
    await this.#withWorkspace((ws) => ws.exists(this.#repoPath));
    return this.#dial.withProject(async (project) => {
      const streams = (
        project as unknown as {
          streams: { get(path: string): { subscribe(args: object): Promise<unknown> } };
        }
      ).streams;
      return (await streams.get(this.#workspacePath).subscribe({
        processEventBatch,
        replayAfterOffset: afterOffset,
      })) as { ping?(): Promise<boolean> | boolean; unsubscribe(): void };
    });
  }

  /** Every task file in the merged view, path → content (board seed).
   * PoC shape: fine for boards of hundreds; the real fix for gigantic repos
   * is a platform-side filtered snapshot (the workspace equivalent of the
   * repo DO's listTaskFiles, which exists precisely because glob+read-each
   * overloads the DO). */
  async files(): Promise<Record<string, string>> {
    return this.#withWorkspace(async (ws) => {
      // Anchored under the repo mount: a relative pattern globs the
      // workspace's private scratch, and other repos' mounts are not this
      // board's business.
      const paths = await ws.glob(`${this.#repoPath}/**/tasks/**/*.md`);
      // Batched platform calls for the whole set — per-file reads through
      // this chain collapse at thousands of tasks. The platform caps one
      // readFiles call at 10,000 paths, so boards beyond that read in
      // chunks; two lanes keep the pipe full without stampeding the DO.
      const CHUNK = 5_000;
      const chunks: string[][] = [];
      for (let index = 0; index < paths.length; index += CHUNK) {
        chunks.push(paths.slice(index, index + CHUNK));
      }
      const contents: Record<string, string | null> = {};
      for (let index = 0; index < chunks.length; index += 2) {
        const pair = await Promise.all(
          chunks.slice(index, index + 2).map((chunk) => ws.readFiles(chunk)),
        );
        for (const part of pair) Object.assign(contents, part);
      }
      // Keys leave here repo-relative (no mount prefix, no leading slash) —
      // one shape for every consumer; qualification is this class's job.
      // Null reads (vanished between glob and read, transient failure) are
      // SKIPPED, never seeded as phantom empty cards.
      return Object.fromEntries(
        Object.entries(contents).flatMap(([path, content]) => {
          const key = this.#repoRelative(path);
          return content === null || key === null ? [] : [[key, content]];
        }),
      );
    });
  }

  read(path: string): Promise<string | null> {
    return this.#withWorkspace((ws) => ws.readFile(this.#qualified(path)));
  }

  write(path: string, content: string): Promise<void> {
    return this.#withWorkspace((ws) => ws.writeFile(this.#qualified(path), content));
  }

  delete(path: string): Promise<boolean> {
    return this.#withWorkspace((ws) => ws.deleteFile(this.#qualified(path)));
  }

  revert(path: string): Promise<void> {
    return this.#withWorkspace((ws) => ws.revert(this.#qualified(path)));
  }

  status(): Promise<unknown> {
    return this.#withWorkspace((ws) => ws.git.status());
  }

  async commit(message: string): Promise<unknown> {
    // scope pins the commit to this capability's mount — commits never span
    // mounts, and every project repo is one now.
    const result = await this.#withWorkspace((ws) =>
      ws.git.commit({ message, scope: this.#repoPath }),
    );
    const commitOid = (result as { commitOid?: unknown } | null)?.commitOid;
    this.#announce(typeof commitOid === "string" ? commitOid : undefined);
    return result;
  }

  log(limit = 5): Promise<unknown> {
    return this.#withWorkspace((ws) => ws.git.log({ limit, scope: this.#repoPath }));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
