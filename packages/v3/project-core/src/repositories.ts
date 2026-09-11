import { z } from "zod";
import { Fault } from "./model.ts";
import { canonical, type EventInput } from "./signatures.ts";
import { sha256 } from "./encoding.ts";

const REPO_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const REVISION = /^[a-f0-9]{64}$/;
const HEADS = `SELECT commits.name, commits.revision, revisions.parent, revisions.message, commits.offset
  FROM repository_heads AS heads
  JOIN repository_commits AS commits ON commits.name = heads.name AND commits.revision = heads.revision
  JOIN repository_revisions AS revisions ON revisions.revision = heads.revision`;
// Other reserved segments (dot paths, __proto__) fail the leading-alphanumeric path rule.
const RESERVED_PATH_SEGMENTS = new Set(["constructor", "prototype"]);

export const RepoCommit = z.strictObject({
  name: z.string().min(1).max(80),
  files: z.record(z.string(), z.string()),
  parent: z.string().regex(REVISION).nullable(),
  message: z.string().min(1).max(4_096),
});

export type RepoCommit = z.infer<typeof RepoCommit>;
export type RepositoryHead = {
  name: string;
  revision: string;
  parent: string | null;
  message: string;
  offset: number;
};
export type RepositoryRevision = Omit<RepositoryHead, "offset"> & { files: Record<string, string> };

/** Immutable source snapshots, installed atomically with their `repo.commit` event. */
export class Repositories {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS repository_revisions (revision TEXT PRIMARY KEY, parent TEXT, message TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS repository_blobs (digest TEXT PRIMARY KEY, content TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS repository_files (revision TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (revision, path))",
      "CREATE TABLE IF NOT EXISTS repository_commits (name TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (name, revision))",
      "CREATE TABLE IF NOT EXISTS repository_heads (name TEXT PRIMARY KEY, revision TEXT NOT NULL)",
    ])
      sql.exec(statement);
  }

  head(name: string): RepositoryHead | undefined {
    this.#name(name);
    return this.#sql.exec<RepositoryHead>(`${HEADS} WHERE heads.name = ?`, name).toArray()[0];
  }

  list(): RepositoryHead[] {
    return this.#sql.exec<RepositoryHead>(`${HEADS} ORDER BY commits.name`).toArray();
  }

  read(name: string, revision?: string): RepositoryRevision {
    this.#name(name);
    const selected = revision ?? this.head(name)?.revision;
    if (!selected) throw new Fault("REPO_NOT_FOUND", `Repository ${name} does not exist`, 404);
    if (!REVISION.test(selected)) throw new Fault("REVISION", "Invalid repository revision");
    const row = this.#sql
      .exec<Omit<RepositoryHead, "name" | "offset">>(
        `SELECT revisions.revision, revisions.parent, revisions.message
         FROM repository_commits AS commits
         JOIN repository_revisions AS revisions ON revisions.revision = commits.revision
         WHERE commits.name = ? AND commits.revision = ?`,
        name,
        selected,
      )
      .toArray()[0];
    if (!row) throw new Fault("REVISION_NOT_FOUND", `Revision is not in repository ${name}`, 404);
    const files: Record<string, string> = {};
    for (const file of this.#sql.exec<{ path: string; content: string }>(
      `SELECT files.path, blobs.content FROM repository_files AS files
       JOIN repository_blobs AS blobs ON blobs.digest = files.digest
       WHERE files.revision = ? ORDER BY files.path`,
      selected,
    ))
      files[file.path] = file.content;
    return { name, ...row, files };
  }

  /** Validate and hash before the log transaction; the returned callback runs inside it after offset assignment. */
  async prepare(event: EventInput): Promise<((offset: number) => void) | undefined> {
    if (event.type !== "repo.commit") return undefined;
    const commit = RepoCommit.parse(event.data);
    this.#name(commit.name);
    const files = this.#files(commit.files);
    const revision = await sha256(
      canonical({ files: commit.files, parent: commit.parent, message: commit.message }),
    );
    const blobs = await Promise.all(
      Object.entries(files).map(async ([path, content]) => ({
        path,
        digest: await sha256(content),
        content,
      })),
    );
    return (offset) => this.#commit(commit, revision, blobs, offset);
  }

  #commit(
    commit: RepoCommit,
    revision: string,
    blobs: ({ digest: string; content: string } & { path: string })[],
    offset: number,
  ): void {
    const current = this.head(commit.name);
    if ((current?.revision ?? null) !== commit.parent) {
      throw new Fault("REPO_HEAD_CONFLICT", `Repository ${commit.name} head changed`, 409);
    }
    this.#sql.exec(
      "INSERT OR IGNORE INTO repository_revisions (revision, parent, message) VALUES (?, ?, ?)",
      revision,
      commit.parent,
      commit.message,
    );
    for (const blob of blobs) {
      this.#sql.exec(
        "INSERT OR IGNORE INTO repository_blobs (digest, content) VALUES (?, ?)",
        blob.digest,
        blob.content,
      );
      this.#sql.exec(
        "INSERT OR IGNORE INTO repository_files (revision, path, digest) VALUES (?, ?, ?)",
        revision,
        blob.path,
        blob.digest,
      );
    }
    this.#sql.exec(
      "INSERT INTO repository_commits (name, revision, offset) VALUES (?, ?, ?)",
      commit.name,
      revision,
      offset,
    );
    this.#sql.exec(
      "INSERT INTO repository_heads (name, revision) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET revision = excluded.revision",
      commit.name,
      revision,
    );
  }

  #name(name: string): void {
    if (!REPO_NAME.test(name)) throw new Fault("REPO", "Invalid repository name");
  }

  #files(files: Record<string, string>): Record<string, string> {
    const entries = Object.entries(files);
    if (!entries.length || entries.length > 256)
      throw new Fault("REPO_FILES", "A revision needs 1 to 256 files");
    for (const [path, content] of entries) {
      const parts = path.split("/");
      if (
        !path ||
        path.length > 240 ||
        parts.some(
          (part) =>
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(part) || RESERVED_PATH_SEGMENTS.has(part),
        )
      ) {
        throw new Fault("REPO_PATH", `Invalid repository path ${path}`);
      }
      if (new TextEncoder().encode(content).byteLength > 65_536)
        throw new Fault("REPO_FILE", `File ${path} exceeds 65536 bytes`);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }
}
