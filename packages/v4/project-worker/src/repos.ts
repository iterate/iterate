// repos.ts — immutable source revisions, projected atomically from ordinary stream facts.

import { z } from "zod";
import type { ItxExpression } from "./context/expression.ts";
import { InvokeHandle } from "./context/invoke-handle.ts";
import { codedError } from "./lib/errors.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import type { SqlStorageHandle } from "./stream/reduce-checkpoint.ts";

export const REPOSITORY_COMMITTED = "events.iterate.com/repo/committed";
const REVISION = /^[a-f0-9]{64}$/;
const PATH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RESERVED = new Set(["constructor", "prototype"]);

const CommitPayload = z.strictObject({
  repoPath: z.string(),
  files: z.record(z.string(), z.string()),
  parent: z.string().regex(REVISION).nullable(),
  message: z.string().min(1).max(4096),
  revision: z.string().regex(REVISION),
});
const CommitInput = CommitPayload.omit({ repoPath: true, revision: true }).extend({
  idempotencyKey: z.string().min(1).max(256).optional(),
  offset: z.number().int().positive().optional(),
});

type VerifiedCommit = { revision: string; files: Record<string, string> };

export type RepositoryHead = {
  revision: string;
  parent: string | null;
  message: string;
  offset: number;
};
export type RepositoryRevision = RepositoryHead & { files: Record<string, string> };
export type RepositoryCommitInput = z.input<typeof CommitInput>;
export type RepositoryScope = { get(path: string): RepositoryHandle };

/** A real capnweb capability, not a plain returned object. `get()` can therefore hand one to a
 * client and `repos.get('/site').commit(...)` remains a normal pipelined dotted call. */
export class RepositoryHandle extends InvokeHandle {
  readonly #repositories: Repositories;
  readonly #repoPath: string;
  readonly #append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>;

  constructor(
    repositories: Repositories,
    repoPath: string,
    append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>,
  ) {
    super((steps) => repositories.dispatch(repoPath, append, steps));
    repositories.assertRepoPath(repoPath);
    this.#repositories = repositories;
    this.#repoPath = repoPath;
    this.#append = append;
  }

  async commit(input: RepositoryCommitInput): Promise<RepositoryHead> {
    return this.#repositories.commit(this.#repoPath, this.#append, input);
  }

  head(): RepositoryHead | null {
    return this.#repositories.head(this.#repoPath);
  }

  read(revision?: string): RepositoryRevision {
    return this.#repositories.read(this.#repoPath, revision);
  }

  list(): RepositoryHead[] {
    return this.#repositories.list(this.#repoPath);
  }
}

/** The one repository projection. `prepare()` runs crypto before append; `apply()` then remains
 * synchronous and transaction-local with the stream row, head and core checkpoint. */
export class Repositories {
  readonly #sql: SqlStorageHandle;
  /** The proof is attached to a cloned payload object's identity, not to wire-visible data. Stream
   * preserves that payload identity while assigning the event envelope, so only this DO turn can
   * project the prepared fact. Weak keys also make an idempotent retry's unused proof collectible. */
  readonly #verifiedPayloads = new WeakMap<object, VerifiedCommit>();

  constructor(sql: SqlStorageHandle) {
    this.#sql = sql;
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS repository_revisions (revision TEXT PRIMARY KEY, parent TEXT, message TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS repository_blobs (digest TEXT PRIMARY KEY, content TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS repository_files (revision TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (revision, path))",
      "CREATE TABLE IF NOT EXISTS repository_commits (repo_path TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (repo_path, revision))",
      "CREATE TABLE IF NOT EXISTS repository_heads (repo_path TEXT PRIMARY KEY, revision TEXT NOT NULL)",
    ])
      this.#sql.exec(statement);
  }

  scope(append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>): RepositoryScope {
    return { get: (repoPath) => new RepositoryHandle(this, repoPath, append) };
  }

  /** Clone and verify every repository fact before Stream opens its synchronous transaction. All
   * non-repository entries retain their existing append shape and identity. */
  async prepare(...events: StreamEventInput[]): Promise<StreamEventInput[]> {
    return Promise.all(events.map((event) => this.prepareOne(event)));
  }

  /** Build the ordinary fact the public commit verb appends. Raw append accepts the same envelope,
   * but must go through `prepare()` before it can change the repository projection. */
  async commitEvent(repoPath: string, input: RepositoryCommitInput): Promise<StreamEventInput> {
    const commit = CommitInput.parse(input);
    const files = this.files(commit.files);
    this.assertRepoPath(repoPath);
    const revision = await sha256(canonicalCommit(files, commit.parent, commit.message));
    return {
      type: REPOSITORY_COMMITTED,
      payload: { repoPath, files, parent: commit.parent, message: commit.message, revision },
      ...(commit.idempotencyKey && { idempotencyKey: commit.idempotencyKey }),
      ...(commit.offset !== undefined && { offset: commit.offset }),
    };
  }

  /** Called by Stream after a fresh durable event has an offset, inside the existing transaction. */
  apply(event: StreamEvent): void {
    if (event.type !== REPOSITORY_COMMITTED) return;
    if (event.ephemeral) throw codedError("REPO_EPHEMERAL", "Repository commits must be durable");
    const payload = event.payload;
    const verified = payload ? this.#verifiedPayloads.get(payload) : undefined;
    if (!verified)
      throw codedError("REPO_UNVERIFIED", "Repository revision was not verified before commit");
    const commit = CommitPayload.parse(payload);
    this.assertRepoPath(commit.repoPath);
    if (commit.revision !== verified.revision)
      throw codedError("REPO_UNVERIFIED", "Repository revision proof does not match the event");
    if ((this.head(commit.repoPath)?.revision ?? null) !== commit.parent)
      throw codedError("REPO_HEAD_CONFLICT", `Repository ${commit.repoPath} head changed`);
    this.#sql.exec(
      "INSERT OR IGNORE INTO repository_revisions (revision, parent, message) VALUES (?, ?, ?)",
      commit.revision,
      commit.parent,
      commit.message,
    );
    for (const [path, content] of Object.entries(verified.files)) {
      const digest = `${commit.revision}:${path}`;
      this.#sql.exec(
        "INSERT OR IGNORE INTO repository_blobs (digest, content) VALUES (?, ?)",
        digest,
        content,
      );
      this.#sql.exec(
        "INSERT OR IGNORE INTO repository_files (revision, path, digest) VALUES (?, ?, ?)",
        commit.revision,
        path,
        digest,
      );
    }
    this.#sql.exec(
      "INSERT INTO repository_commits (repo_path, revision, offset) VALUES (?, ?, ?)",
      commit.repoPath,
      commit.revision,
      event.offset,
    );
    this.#sql.exec(
      "INSERT INTO repository_heads (repo_path, revision) VALUES (?, ?) ON CONFLICT(repo_path) DO UPDATE SET revision = excluded.revision",
      commit.repoPath,
      commit.revision,
    );
  }

  async commit(
    repoPath: string,
    append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>,
    input: RepositoryCommitInput,
  ): Promise<RepositoryHead> {
    const [event] = await append(await this.commitEvent(repoPath, input));
    const payload = CommitPayload.parse(event.payload);
    return this.commitAt(payload.repoPath, payload.revision);
  }

  dispatch(
    repoPath: string,
    append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>,
    steps: ItxExpression,
  ): unknown {
    const [step] = steps;
    if (steps.length !== 1 || !Array.isArray(step))
      throw new Error("repos.get(): repository capabilities expose one method per call");
    const [method, ...args] = step;
    if (method === "commit") return this.commit(repoPath, append, CommitInput.parse(args[0]));
    if (method === "head") return this.head(repoPath);
    if (method === "read") {
      const revision = args[0];
      if (revision !== undefined && typeof revision !== "string")
        throw codedError("REPO_REVISION", "Invalid repository revision");
      return this.read(repoPath, revision);
    }
    if (method === "list") return this.list(repoPath);
    throw new Error(`repos.get(): unknown repository method ${method}`);
  }

  head(repoPath: string): RepositoryHead | null {
    this.assertRepoPath(repoPath);
    return (
      this.#sql.exec<RepositoryHead>(`${heads} WHERE heads.repo_path = ?`, repoPath).toArray()[0] ??
      null
    );
  }

  list(repoPath: string): RepositoryHead[] {
    this.assertRepoPath(repoPath);
    return this.#sql
      .exec<RepositoryHead>(
        `SELECT commits.revision, revisions.parent, revisions.message, commits.offset
         FROM repository_commits AS commits
         JOIN repository_revisions AS revisions ON revisions.revision = commits.revision
         WHERE commits.repo_path = ? ORDER BY commits.offset DESC`,
        repoPath,
      )
      .toArray();
  }

  read(repoPath: string, revision?: string): RepositoryRevision {
    this.assertRepoPath(repoPath);
    const selected = revision ?? this.head(repoPath)?.revision;
    if (!selected) throw codedError("REPO_NOT_FOUND", `Repository ${repoPath} does not exist`);
    if (!REVISION.test(selected)) throw codedError("REPO_REVISION", "Invalid repository revision");
    const head = this.commitAt(repoPath, selected);
    const files: Record<string, string> = {};
    for (const row of this.#sql.exec<{ path: string; content: string }>(
      `SELECT files.path, blobs.content FROM repository_files AS files
       JOIN repository_blobs AS blobs ON blobs.digest = files.digest
       WHERE files.revision = ? ORDER BY files.path`,
      selected,
    ))
      files[row.path] = row.content;
    return { ...head, files };
  }

  commitAt(repoPath: string, revision: string): RepositoryHead {
    const row = this.#sql
      .exec<RepositoryHead>(
        `SELECT commits.revision, revisions.parent, revisions.message, commits.offset
         FROM repository_commits AS commits
         JOIN repository_revisions AS revisions ON revisions.revision = commits.revision
         WHERE commits.repo_path = ? AND commits.revision = ?`,
        repoPath,
        revision,
      )
      .toArray()[0];
    if (!row)
      throw codedError("REPO_REVISION_NOT_FOUND", `Revision is not in repository ${repoPath}`);
    return row;
  }

  assertRepoPath(path: string): void {
    if (
      !path.startsWith("/") ||
      path.length > 240 ||
      path
        .split("/")
        .slice(1)
        .some((part) => !PATH_PART.test(part) || RESERVED.has(part))
    )
      throw codedError("REPO_PATH", `Invalid repository path ${path}`);
  }

  files(files: Record<string, string>): Record<string, string> {
    const entries = Object.entries(files);
    if (entries.length < 1 || entries.length > 256)
      throw codedError("REPO_FILES", "A revision needs 1 to 256 files");
    for (const [path, content] of entries) {
      const parts = path.split("/");
      if (
        !path ||
        path.length > 240 ||
        parts.some((part) => !PATH_PART.test(part) || RESERVED.has(part))
      )
        throw codedError("REPO_FILE_PATH", `Invalid repository file path ${path}`);
      if (new TextEncoder().encode(content).byteLength > 65_536)
        throw codedError("REPO_FILE", `File ${path} exceeds 65536 bytes`);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }

  async prepareOne(event: StreamEventInput): Promise<StreamEventInput> {
    if (event.type !== REPOSITORY_COMMITTED) return event;
    if (event.ephemeral) throw codedError("REPO_EPHEMERAL", "Repository commits must be durable");
    const commit = CommitPayload.parse(event.payload);
    const files = this.files(commit.files);
    this.assertRepoPath(commit.repoPath);
    const revision = await sha256(canonicalCommit(files, commit.parent, commit.message));
    if (commit.revision !== revision)
      throw codedError(
        "REPO_REVISION",
        "Repository revision does not match its immutable contents",
      );
    const payload = { ...commit, files };
    this.#verifiedPayloads.set(payload, { revision, files });
    return { ...event, payload };
  }
}

const heads = `SELECT commits.revision, revisions.parent, revisions.message, commits.offset
  FROM repository_heads AS heads
  JOIN repository_commits AS commits ON commits.repo_path = heads.repo_path AND commits.revision = heads.revision
  JOIN repository_revisions AS revisions ON revisions.revision = heads.revision`;

function canonicalCommit(
  files: Record<string, string>,
  parent: string | null,
  message: string,
): string {
  return JSON.stringify({ files, parent, message });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
