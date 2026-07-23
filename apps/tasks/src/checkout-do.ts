import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import type { Project, UnauthenticatedOs } from "iterate/client";
import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import type { AppEnv } from "./env.ts";
import type { CommitResult, TaskChangeSummary } from "./state.ts";
import {
  fallbackCommitMessage,
  isTaskFilePath,
  parseTaskCard,
  setTaskCardAgent,
  setTaskCardState,
  taskAgentPath,
  taskAssignmentInstructions,
  taskColumnState,
  taskCommitMessagePrompt,
} from "./tasks-model.ts";
import {
  AGENT_COLLABORATOR,
  applyTextEdit,
  checkoutBaseCommit,
  checkoutBaseContents,
  checkoutFileContents,
  checkoutFilesMap,
  checkoutMetaMap,
  checkoutRepoChanges,
  checkoutTaskChanges,
  normalizeRepoPath,
  registerCollaborator,
} from "./lib/checkout-shared.ts";
import type { CheckoutSnapshot, ProjectCredential } from "./lib/tasks-api.ts";
const PROJECT_ID_HEADER = "x-itx-project-id";
const AUTH_COOKIE = "iterate-project-auth";
const TASK_COMMIT_MODEL = "openai/gpt-5.5";
const DOC_STORAGE_KEY = "doc";

/**
 * One collaborative checkout = one y-partyserver YServer Durable Object,
 * named `<projectId>:<repoPath>:<checkoutId>` (any of the project's repos —
 * the picker on `/` chooses; /repos/config is the default). The stock mixin
 * does all the Yjs work —
 * y-protocols sync + awareness relay over `/yjs/<id>` WebSockets
 * (the standard y-websocket wire, so the stock provider and editor bindings
 * just work) plus a debounced `onSave`. This subclass only adds:
 *
 *  - `onLoad`/`onSave`: the shared doc persists as one update blob in DO
 *    storage (the y-partyserver README pattern).
 *  - `onConnect` auth + seeding: the vessel holds no secrets, so each join's
 *    proxy-stamped `iterate-project-auth` token is verified by USING it
 *    against `${OS_BASE_URL}/api`; the first successful join seeds the doc
 *    from the repo's task files at HEAD ("files": path → Y.Text, "meta":
 *    base commit + base contents).
 *  - plain-data RPC methods (ensureSeeded/filesSnapshot/applyWrite/
 *    commitDoc/…) — the git and agent ops behind the capnweb API in
 *    rpc-api.ts. Mutations transact on the live doc, so the mixin's update
 *    hook broadcasts them to every collaborator and schedules persistence.
 */
export class TasksCheckoutDurableObject extends YServer {
  #env(): AppEnv {
    return this.env as unknown as AppEnv;
  }

  async onLoad(): Promise<void> {
    const stored = await this.ctx.storage.get<Uint8Array>(DOC_STORAGE_KEY);
    if (stored) Y.applyUpdate(this.document, stored);
  }

  async onSave(): Promise<void> {
    await this.ctx.storage.put(DOC_STORAGE_KEY, Y.encodeStateAsUpdate(this.document));
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    try {
      const repoPath = repoPathFromRequest(ctx.request);
      await this.#withDial(ctx.request, (dial) => this.#verifyAndSeed(dial, repoPath));
      const projectId = ctx.request.headers.get(PROJECT_ID_HEADER);
      if (projectId) this.#reportToIndex(projectId, repoPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      connection.close(4403, `session rejected: ${reason}`.slice(0, 120));
      return;
    }
    super.onConnect(connection, ctx);
  }

  /**
   * Tell the project's checkout index this checkout exists / is active.
   * Fire-and-forget: the index is a convenience catalog for the sidebar,
   * never worth failing a join or commit over.
   */
  #reportToIndex(projectId: string, repoPath: string): void {
    const checkoutId = this.name.split(":").at(-1);
    if (!checkoutId) return;
    this.ctx.waitUntil(
      this.#env()
        .INDEX.getByName(projectId)
        .record({ repoPath, checkoutId, baseCommit: checkoutBaseCommit(this.document) })
        .catch(() => {}),
    );
  }

  /** The seed read both proves the token works and provides the board.
   * (The platform's listTaskFiles was ripped out of the OS repos API by
   * iterate#2222; the legacy lane now composes it from listFiles + capped
   * readFile — acceptable here, this lane retires with the workspace board.) */
  async #verifyAndSeed(dial: ProjectDial, repoPath: string): Promise<void> {
    const listing = await dial.withProject(async (project) => {
      const repo = project.repos.get(repoPath);
      const { commitOid, paths } = (await repo.listFiles()) as {
        commitOid: string;
        paths: string[];
      };
      // Keys are REPO-RELATIVE (no leading slash) — the doc's key shape
      // everywhere else; reads keep the listing's original path.
      const taskPaths = paths
        .map((path) => ({ key: path.replace(/^\/+/, ""), path }))
        .filter((entry) => isTaskFilePath(entry.key));
      const files: Record<string, string> = {};
      const lane = 16;
      for (let start = 0; start < taskPaths.length; start += lane) {
        await Promise.all(
          taskPaths.slice(start, start + lane).map(async (entry) => {
            // Tolerate per-file failures (deleted between list and read,
            // transient RPC): one bad file must not block the whole seed.
            try {
              const file = (await repo.readFile({ commitOid, path: entry.path })) as {
                content: string;
              } | null;
              if (file !== null) files[entry.key] = file.content;
            } catch {
              // skipped — the poll/commit lanes reconcile it later
            }
          }),
        );
      }
      return { commitOid, files };
    });
    // Re-check after the await: a racing join may have seeded already.
    if (checkoutBaseCommit(this.document) !== undefined) return;
    this.document.transact(() => {
      const files = checkoutFilesMap(this.document);
      for (const [path, content] of Object.entries(listing.files)) {
        if (!isTaskFilePath(path)) continue;
        files.set(path, new Y.Text(content));
      }
      const meta = checkoutMetaMap(this.document);
      meta.set("baseCommit", listing.commitOid);
      meta.set("base", listing.files);
    });
  }

  /** Non-upgrade HTTP has no business here — the API lives at /api (capnweb). */
  override async onRequest(): Promise<Response> {
    return new Response("not found — the tasks API is capnweb at /api", { status: 404 });
  }

  /**
   * Seed the doc from the repo's HEAD task files if nobody has yet — the
   * capnweb lane's counterpart to the onConnect seeding, so an agent can be
   * the very first thing that ever touches a checkout. Verifies the token by
   * using it, same as a join.
   */
  async ensureSeeded(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
  ): Promise<void> {
    if (checkoutBaseCommit(this.document) === undefined) {
      await this.#withCredentialDial(projectId, credential, (dial) =>
        this.#verifyAndSeed(dial, repoPath),
      );
    }
    this.#reportToIndex(projectId, repoPath);
  }

  async filesSnapshot(): Promise<CheckoutSnapshot> {
    return {
      baseCommit: checkoutBaseCommit(this.document) ?? "",
      files: checkoutFileContents(this.document),
    };
  }

  async readFile(path: string): Promise<string | null> {
    const text = checkoutFilesMap(this.document).get(path);
    return text === undefined ? null : text.toString();
  }

  /**
   * Set (or with `content === null`, delete) one task file on the live doc.
   * Existing files get a minimal splice, so a collaborator typing elsewhere
   * in the same file keeps their characters.
   */
  async applyWrite(path: string, content: string | null): Promise<void> {
    if (!isTaskFilePath(path)) {
      throw new Error(`${path} is not a task file — checkouts only edit tasks/ markdown`);
    }
    this.document.transact(() => {
      // API-lane writes all share this doc's client — give it a face so
      // collaborators' recency glows can say "agent".
      registerCollaborator(this.document, AGENT_COLLABORATOR);
      const files = checkoutFilesMap(this.document);
      if (content === null) {
        files.delete(path);
        return;
      }
      const existing = files.get(path);
      if (existing) applyTextEdit(existing, content);
      else files.set(path, new Y.Text(content));
    });
  }

  async changesSummary(): Promise<TaskChangeSummary[]> {
    return checkoutTaskChanges(
      checkoutFileContents(this.document),
      checkoutBaseContents(this.document),
    );
  }

  async commitDoc(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
    message: string,
  ): Promise<CommitResult> {
    const result = await this.#withCredentialDial(projectId, credential, (dial) =>
      this.#commit(dial, repoPath, message),
    );
    this.#reportToIndex(projectId, repoPath);
    return result;
  }

  /**
   * The apps/os assignment flow against the live doc: frontmatter first
   * (state + agent, visible to every collaborator instantly), then ONE
   * commit so a born agent always finds its durable assignment at HEAD,
   * then birth-if-needed and the kickoff brief.
   */
  async assignAgentDoc(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
    taskPath: string,
  ): Promise<{ agentPath: string }> {
    const text = checkoutFilesMap(this.document).get(taskPath);
    if (text === undefined) throw new Error(`${taskPath} does not exist in this checkout`);
    const source = text.toString();
    const card = parseTaskCard(taskPath, source);
    if (card.agent !== null) return { agentPath: card.agent };
    const agentPath = taskAgentPath(repoPath, taskPath);
    const staged =
      taskColumnState(card.state) === "in-progress" ? source : setTaskCardState(source, "in-progress");
    const content = setTaskCardAgent(staged, agentPath);
    this.document.transact(() => {
      applyTextEdit(text, content);
    });
    return this.#withCredentialDial(projectId, credential, async (dial) => {
      await this.#commit(dial, repoPath, `Assign task: ${card.title}`);
      await dial.withProject(async (project) => {
        const agent = (
          project as unknown as {
            agents: {
              get(path: string): {
                processor: { snapshot(): Promise<{ state?: { birthCertificate?: unknown } }> };
                create(): Promise<unknown>;
                message(text: string): Promise<unknown>;
              };
            };
          }
        ).agents.get(agentPath);
        const snapshot = await agent.processor.snapshot();
        if ((snapshot.state?.birthCertificate ?? null) === null) await agent.create();
        await agent.message(taskAssignmentInstructions(repoPath, taskPath));
      });
      this.#reportToIndex(projectId, repoPath);
      return { agentPath };
    });
  }

  async generateMessageDoc(credential: ProjectCredential, projectId: string): Promise<string> {
    const changes = await this.changesSummary();
    return this.#withCredentialDial(projectId, credential, (dial) =>
      this.#generateCommitMessage(dial, changes),
    );
  }

  /**
   * One git commit of the checkout's diff against base, as the posting user.
   * The post-commit base rewrite uses the same pre-await file snapshot the
   * diff was computed from, so anything typed while the commit was in
   * flight stays visibly uncommitted — and the meta update syncs the new
   * base to every collaborator.
   */
  async #commit(dial: ProjectDial, repoPath: string, message: string): Promise<CommitResult> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("a commit needs a message");
    const files = checkoutFileContents(this.document);
    const base = checkoutBaseContents(this.document);
    const changes = checkoutRepoChanges(files, base);
    if (changes.length === 0) {
      return {
        branch: "",
        changedPaths: [],
        commitOid: checkoutBaseCommit(this.document) ?? "",
        noChanges: true,
      };
    }
    for (const change of changes) {
      if (!isTaskFilePath(change.path)) {
        throw new Error(`${change.path} is not a task file — the checkout only commits tasks/ markdown`);
      }
    }
    const result = (await dial.withProject((project) =>
      project.repos.get(repoPath).commitFiles({ message: trimmed, changes }),
    )) as CommitResult;
    this.document.transact(() => {
      const meta = checkoutMetaMap(this.document);
      meta.set("baseCommit", result.commitOid);
      meta.set("base", files);
    });
    await this.onSave();
    return result;
  }

  async #generateCommitMessage(dial: ProjectDial, changes: TaskChangeSummary[]): Promise<string> {
    const prompt = taskCommitMessagePrompt(changes);
    const result = (await dial.withProject((project) =>
      project.ai.run(TASK_COMMIT_MODEL, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    )) as { response?: string };
    const generated = result.response?.trim().replace(/^["']|["']$/g, "");
    return generated ? generated.slice(0, 72) : fallbackCommitMessage(changes);
  }

  /** Per-operation platform dial from the request's own proxy-stamped auth. */
  async #withDial<T>(request: Request, operation: (dial: ProjectDial) => Promise<T>): Promise<T> {
    const projectId = request.headers.get(PROJECT_ID_HEADER);
    const token = readCookie(request, AUTH_COOKIE);
    if (!projectId || !token) throw new Error("missing project id or session token");
    return this.#withCredentialDial(
      projectId,
      { type: "project-app-session", token },
      operation,
    );
  }

  /** Same dial, from an explicit credential — the capnweb RPC lane's entry. */
  async #withCredentialDial<T>(
    projectId: string,
    credential: ProjectCredential,
    operation: (dial: ProjectDial) => Promise<T>,
  ): Promise<T> {
    const dial = new ProjectDial(this.#env().OS_BASE_URL, projectId, credential);
    try {
      return await operation(dial);
    } finally {
      dial.close();
    }
  }
}

/**
 * A lazy dial to the platform as one principal: opened on first use,
 * redialed once when a cached session goes stale mid-operation. The
 * credential decides who — a user (`project-app-session`, the browser lane)
 * or the project itself (`project-secret`, the machine lane).
 */
export class ProjectDial {
  #project: RpcStub<Project> | null = null;
  #socket: WebSocket | null = null;
  #session: { [Symbol.dispose]?: () => void } | null = null;
  #closed = false;

  constructor(
    private readonly osBaseUrl: string,
    private readonly projectId: string,
    private readonly credential: ProjectCredential,
  ) {}

  async #open(): Promise<RpcStub<Project>> {
    this.#dispose();
    const response = await fetch(new URL("/api", this.osBaseUrl).toString(), {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`os /api did not upgrade: ${response.status}`);
    socket.accept();
    this.#socket = socket as unknown as WebSocket;
    const os = newWebSocketRpcSession<UnauthenticatedOs>(socket as unknown as WebSocket);
    this.#session = os as { [Symbol.dispose]?: () => void };
    const session = os.authenticate(this.credential as never);
    return session.projects.get(this.projectId) as unknown as RpcStub<Project>;
  }

  async withProject<T>(operation: (project: RpcStub<Project>) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("connection closed");
    if (!this.#project) this.#project = await this.#open();
    try {
      return await operation(this.#project);
    } catch (firstError) {
      this.#project = await this.#open();
      try {
        return await operation(this.#project);
      } catch (secondError) {
        this.#project = null;
        throw secondError ?? firstError;
      }
    }
  }

  #dispose(): void {
    try {
      this.#session?.[Symbol.dispose]?.();
    } catch {
      // dispose races on a half-open socket are fine
    }
    try {
      this.#socket?.close();
    } catch {
      // ignore
    }
    this.#socket = null;
    this.#session = null;
    this.#project = null;
  }

  close(): void {
    this.#closed = true;
    this.#dispose();
  }
}

/**
 * The repo this checkout edits, from the `?repoPath=` query the worker also
 * bound into the DO's name — so every request a given instance sees carries
 * the same value. Absent means /repos/config.
 */
function repoPathFromRequest(request: Request): string {
  const repoPath = normalizeRepoPath(new URL(request.url).searchParams.get("repoPath"));
  if (repoPath === null) throw new Error("bad repoPath");
  return repoPath;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
