import { describe, expect, it, vi } from "vitest";
import { executeRepoCommitCommand, type RepoCommitCommandKv } from "./repo-commit-command.ts";
import type { RepoCommitCommand } from "./types.ts";

function fakeKv(): RepoCommitCommandKv & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    get: <T>(key: string) => records.get(key) as T | undefined,
    put: (key, value) => void records.set(key, structuredClone(value)),
    records,
  };
}

const command: RepoCommitCommand = {
  input: {
    changes: [{ content: "hello", path: "notes/example.md" }],
    message: "Add the example",
  },
  operationId: "8d1799be-845a-4cf4-b79b-70a2dd192b5e",
};

describe("executeRepoCommitCommand", () => {
  it("returns the same durable result when the outer acknowledgement is lost", async () => {
    const kv = fakeKv();
    const commit = vi.fn(async () => ({
      branch: "main",
      changedPaths: ["notes/example.md"],
      commitOid: "commit-1",
      noChanges: false,
    }));

    const first = await executeRepoCommitCommand({ command, commit, kv });
    expect(first.commitOid).toBe("commit-1");

    // The caller never observed `first`; a fresh Workspace incarnation sends
    // the identical command to this Repo again.
    await expect(executeRepoCommitCommand({ command, commit, kv })).resolves.toEqual(first);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects operation-id reuse with different input", async () => {
    const kv = fakeKv();
    const commit = vi.fn(async () => ({
      branch: "main",
      changedPaths: ["notes/example.md"],
      commitOid: "commit-1",
      noChanges: false,
    }));
    await executeRepoCommitCommand({ command, commit, kv });

    await expect(
      executeRepoCommitCommand({
        command: { ...command, input: { ...command.input, message: "Different" } },
        commit,
        kv,
      }),
    ).rejects.toThrow(/replayed with different input/);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps an interrupted external mutation ambiguous instead of duplicating it", async () => {
    const kv = fakeKv();
    const commit = vi.fn(async () => {
      throw new Error("connection lost after push");
    });
    await expect(executeRepoCommitCommand({ command, commit, kv })).rejects.toThrow(
      /connection lost/,
    );

    await expect(executeRepoCommitCommand({ command, commit, kv })).rejects.toThrow(
      /outcome is ambiguous/,
    );
    expect(commit).toHaveBeenCalledOnce();
  });
});
