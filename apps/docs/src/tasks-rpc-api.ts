import { RpcTarget } from "capnweb";
import type { ProjectDial } from "@iterate-com/workspace-documents/server";
import type {
  CollabAcceptResult,
  CollabChanges,
  CollabOpened,
  CollabWaitResult,
  WorkspaceGitLogEntry,
  WorkspaceStreamEvent,
  TasksWorkspace,
} from "./lib/tasks-api.ts";
import { isGuestWorkspacePath } from "./lib/board-shared.ts";
import {
  parseTaskCard,
  setTaskCardAgent,
  setTaskCardState,
  taskAgentPath,
  taskAssignmentInstructions,
  taskColumnState,
} from "./tasks-model.ts";

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
    commit(input: {
      amendIfHead?: string;
      message: string;
      scope: string;
    }): Promise<{ amended: boolean; commitOid: string }>;
    log(input: { limit?: number; scope: string }): Promise<WorkspaceGitLogEntry[]>;
  };
};

/** The agent surface assignAgent touches (same pinned-client caveat). */
type AgentStub = {
  create(): Promise<unknown>;
  message(text: string): Promise<unknown>;
  processor: { snapshot(): Promise<{ state?: { birthCertificate?: unknown } }> };
};

/**
 * One workspace as a board capability, forwarded over the vessel's live
 * dial. Stateless beyond the dial (versions/epochs live in the workspace
 * DO), and carrying both lanes: the collaborative session wire and the
 * board (files/status/commit — the overlay IS the diff, no base snapshot
 * anywhere; live sessions settle inside the workspace's own barriers).
 *
 * Path contract: the collab lane (open/push/wait/present/changes) speaks
 * fully qualified `/repos/**` paths — a session's identity is its platform
 * path, shared with agents. Every other path crosses this class repo-relative
 * (leading slash optional); #qualified/#repoRelative are the ONLY join between
 * board keys and the mount prefix.
 */
export class TasksWorkspaceApi extends RpcTarget implements TasksWorkspace {
  readonly #dial: ProjectDial;
  readonly #workspacePath: string;
  readonly #repoPath: string;
  /** Boards on the tasks app's own naming are created on first use; a lens
   * addressed at an arbitrary workspace path never creates (plain get). */
  readonly #lazyCreate: boolean;
  #created = false;

  constructor(
    dial: ProjectDial,
    workspacePath: string,
    repoPath: string,
    posture: { lazyCreate: boolean },
  ) {
    super();
    this.#dial = dial;
    this.#workspacePath = workspacePath;
    this.#repoPath = repoPath;
    this.#lazyCreate = posture.lazyCreate;
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

  /**
   * Publishing is the workspace OWNER's act. The tasks app owns only its own
   * /workspaces/tasks/ naming (boards, shared by every project member), and
   * a board workspace ENCODES its one repo — so owner acts additionally
   * require this capability to be scoped to that repo. Everything else is a
   * guest lens: it reads, comments, and edits, but a commit would publish a
   * mount's ENTIRE dirty set (the owning agent's uncommitted work included),
   * so the owner acts are refused here.
   */
  #assertOwnerAct(operation: string): void {
    if (isGuestWorkspacePath(this.#workspacePath, this.#repoPath)) {
      throw new Error(
        `${operation} is the workspace owner's act — this board is a guest lens on ${this.#workspacePath}; ask the workspace's owner (its agent) to publish`,
      );
    }
  }

  async #withWorkspace<T>(operation: (ws: WorkspaceStub) => Promise<T>): Promise<T> {
    return this.#dial.withProject(async (project) => {
      const workspaces = (
        project as unknown as { workspaces: { get(path: string): WorkspaceStub } }
      ).workspaces;
      // For boards the workspace identity ENCODES the repo (see
      // boardWorkspacePath): the same board id against a different
      // repository can never bind to (and edit) the first repository's
      // workspace.
      const ws = workspaces.get(this.#workspacePath);
      try {
        return await operation(ws);
      } catch (error) {
        // Only the workspace-missing error (exact platform phrasing) on a
        // lazily-creating board triggers creation — a file-level "does not
        // exist" (and ANY error on a plain-get lens) must surface as-is.
        if (
          !this.#lazyCreate ||
          this.#created ||
          !/workspace "[^"]+" does not exist/.test(
            error instanceof Error ? error.message : String(error),
          )
        ) {
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
    // A REAL workspace call: on a fresh board it throws the
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

  glob(pattern: string): Promise<string[]> {
    return this.#withWorkspace(async (ws) => {
      const paths = await ws.glob(this.#qualified(pattern));
      return paths.flatMap((path) => {
        const key = this.#repoRelative(path);
        return key === null ? [] : [key];
      });
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

  async commit(
    message: string,
    options: { amendIfHead?: string } = {},
  ): Promise<{ amended: boolean; commitOid: string }> {
    this.#assertOwnerAct("commit");
    // scope pins the commit to this capability's mount — commits never span
    // mounts, and every project repo is one now.
    return this.#withWorkspace((ws) =>
      ws.git.commit({
        ...(options.amendIfHead === undefined ? {} : { amendIfHead: options.amendIfHead }),
        message,
        scope: this.#repoPath,
      }),
    );
  }

  log(limit = 5): Promise<WorkspaceGitLogEntry[]> {
    return this.#withWorkspace((ws) => ws.git.log({ limit, scope: this.#repoPath }));
  }

  /**
   * Assign an agent to one task, the apps/os way: frontmatter first
   * (`state: in-progress` + `agent:`, visible to every collaborator through
   * the live workspace), then ONE commit so a born agent always finds its
   * durable assignment at HEAD, then birth-if-needed and the kickoff brief.
   * Commits the mount, so it is an owner act like commit itself.
   */
  async assignAgent(path: string): Promise<{ agentPath: string }> {
    this.#assertOwnerAct("assignAgent");
    const source = await this.#withWorkspace((ws) => ws.readFile(this.#qualified(path)));
    if (source === null) throw new Error(`${path} does not exist in this workspace`);
    const card = parseTaskCard(path, source);
    if (card.agent !== null) return { agentPath: card.agent };
    const agentPath = taskAgentPath(this.#repoPath, path);
    const staged =
      taskColumnState(card.state) === "in-progress"
        ? source
        : setTaskCardState(source, "in-progress");
    const content = setTaskCardAgent(staged, agentPath);
    await this.#withWorkspace(async (ws) => {
      await ws.writeFile(this.#qualified(path), content);
      await ws.git.commit({ message: `Assign task: ${card.title}`, scope: this.#repoPath });
    });
    await this.#dial.withProject(async (project) => {
      // Same pinned-client caveat as WorkspaceStub: the `iterate` client
      // types predate the agents surface, and capnweb stubs are Proxies, so
      // the locally asserted AgentStub members resolve at runtime.
      const agent = (project as unknown as { agents: { get(path: string): AgentStub } }).agents.get(
        agentPath,
      );
      const snapshot = await agent.processor.snapshot();
      if ((snapshot.state?.birthCertificate ?? null) === null) await agent.create();
      await agent.message(taskAssignmentInstructions(this.#repoPath, path));
    });
    return { agentPath };
  }
}
