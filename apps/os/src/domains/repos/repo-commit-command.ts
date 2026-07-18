import { stableSha256 } from "../workers/utils.ts";
import type { CommitRepoFilesInput, CommitRepoFilesResult, RepoCommitCommand } from "./types.ts";

const REPO_COMMIT_COMMAND_KEY_PREFIX = "repo-commit-command:v1:";

type RepoCommitCommandRecord = {
  inputHash: string;
  result?: CommitRepoFilesResult;
  state: "pending" | "completed";
  version: 1;
};

export interface RepoCommitCommandKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

function commandStorageKey(operationId: string): string {
  if (!/^[0-9a-z-]{36}$/i.test(operationId)) {
    throw new Error("repo commit operationId must be a UUID.");
  }
  return `${REPO_COMMIT_COMMAND_KEY_PREFIX}${operationId}`;
}

function isCommandRecord(value: unknown): value is RepoCommitCommandRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<RepoCommitCommandRecord>;
  return (
    record.version === 1 &&
    typeof record.inputHash === "string" &&
    (record.state === "pending" || (record.state === "completed" && record.result !== undefined))
  );
}

/**
 * Execute one workspace-driven repo mutation at most once.
 *
 * The pending marker lands before the external Artifacts push. A completed
 * result is replayable after an outer RPC acknowledgement disappears. If the
 * Repo Durable Object itself dies while the push is in flight, its outcome is
 * genuinely ambiguous; retaining the pending marker and failing explicitly
 * is safer than manufacturing a duplicate commit.
 */
export async function executeRepoCommitCommand(input: {
  command: RepoCommitCommand;
  commit: (input: CommitRepoFilesInput) => Promise<CommitRepoFilesResult>;
  kv: RepoCommitCommandKv;
}): Promise<CommitRepoFilesResult> {
  const key = commandStorageKey(input.command.operationId);
  const inputHash = await stableSha256({
    input: input.command.input,
    type: "repo-commit-command",
  });
  const existing = input.kv.get<unknown>(key);
  if (existing !== undefined) {
    if (!isCommandRecord(existing)) {
      throw new Error(`Repo commit receipt "${input.command.operationId}" is corrupt.`);
    }
    if (existing.inputHash !== inputHash) {
      throw new Error(
        `Repo commit operation "${input.command.operationId}" was replayed with different input.`,
      );
    }
    if (existing.state === "completed") return existing.result!;
    throw new Error(
      `Repo commit operation "${input.command.operationId}" has an unresolved durable intent; ` +
        "its external push outcome is ambiguous, so it will not be repeated.",
    );
  }

  input.kv.put(key, { inputHash, state: "pending", version: 1 } satisfies RepoCommitCommandRecord);
  const result = await input.commit(input.command.input);
  input.kv.put(key, {
    inputHash,
    result,
    state: "completed",
    version: 1,
  } satisfies RepoCommitCommandRecord);
  return result;
}
