import { describe, expect, test, vi } from "vitest";
import type { AgentMessageAttachment } from "@iterate-com/shared/agent-message-attachments";
import {
  AGENT_REFERENCE_MAX_FILE_BYTES,
  AGENT_REFERENCE_MAX_TOTAL_BYTES,
  materializeAgentReferences,
  renderAgentReferenceMaterialization,
} from "./agent-reference-materialization.ts";

function referenceAttachments(paths: string[]): AgentMessageAttachment[] {
  return paths.map((path) => ({
    id: `config-repo/${path}`,
    type: "repo-file",
    repoPath: "/repos/config",
    path,
  }));
}

describe("agent reference materialization", () => {
  test("reads and includes one linked latest coordinate once", async () => {
    const read = vi.fn(async () => ({
      bytes: new TextEncoder().encode("# Instructions"),
      commitOid: "latest-oid",
      originalBytes: 14,
      truncated: false,
    }));
    const outcomes = await materializeAgentReferences(referenceAttachments(["AGENTS.md"]), read);

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(
      { type: "repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
      AGENT_REFERENCE_MAX_FILE_BYTES,
    );
    expect(outcomes).toEqual([
      {
        status: "resolved",
        target: { type: "repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
        attachmentIds: ["config-repo/AGENTS.md"],
        resolvedCommitOid: "latest-oid",
        originalBytes: 14,
        includedBytes: 14,
        truncated: false,
        content: "# Instructions",
      },
    ]);
    expect(renderAgentReferenceMaterialization(42, outcomes)).toContain("# Instructions");
  });

  test("classifies missing, invalid UTF-8, and failed reads", async () => {
    const outcomes = await materializeAgentReferences(
      referenceAttachments(["missing.txt", "binary.dat", "failed.txt"]),
      async (target) => {
        if (target.path === "missing.txt") return null;
        if (target.path === "binary.dat") {
          return {
            bytes: Uint8Array.of(0xff),
            commitOid: "binary-oid",
            originalBytes: 1,
            truncated: false,
          };
        }
        throw new Error("repo unavailable");
      },
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["missing", "binary", "read-failed"]);
    expect(outcomes[2]).toMatchObject({ message: "repo unavailable" });
  });

  test("enforces per-file and total UTF-8 byte budgets", async () => {
    const bytes = new TextEncoder().encode("x".repeat(AGENT_REFERENCE_MAX_FILE_BYTES + 100));
    const requestedMaximums: number[] = [];
    let activeReads = 0;
    let maximumActiveReads = 0;
    const outcomes = await materializeAgentReferences(
      referenceAttachments(["one.txt", "two.txt", "three.txt"]),
      async (_target, maximumBytes) => {
        requestedMaximums.push(maximumBytes);
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await Promise.resolve();
        activeReads -= 1;
        return {
          bytes: bytes.slice(0, maximumBytes),
          commitOid: "latest-oid",
          originalBytes: bytes.byteLength,
          truncated: maximumBytes < bytes.byteLength,
        };
      },
    );
    const resolved = outcomes.filter((outcome) => outcome.status === "resolved");
    expect(requestedMaximums).toEqual([
      AGENT_REFERENCE_MAX_FILE_BYTES,
      AGENT_REFERENCE_MAX_FILE_BYTES,
      0,
    ]);
    expect(maximumActiveReads).toBe(1);
    expect(resolved.map((outcome) => outcome.includedBytes)).toEqual([
      AGENT_REFERENCE_MAX_FILE_BYTES,
      AGENT_REFERENCE_MAX_FILE_BYTES,
      0,
    ]);
    expect(resolved.reduce((total, outcome) => total + outcome.includedBytes, 0)).toBe(
      AGENT_REFERENCE_MAX_TOTAL_BYTES,
    );
    expect(resolved.every((outcome) => outcome.truncated)).toBe(true);
  });

  test("removes an incomplete UTF-8 code point from a bounded prefix", async () => {
    const fullBytes = new TextEncoder().encode(`${"x".repeat(10)}€ trailing`);
    const outcomes = await materializeAgentReferences(
      referenceAttachments(["unicode.txt"]),
      async () => ({
        bytes: fullBytes.slice(0, 12),
        commitOid: "latest-oid",
        originalBytes: fullBytes.byteLength,
        truncated: true,
      }),
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "resolved",
        content: "x".repeat(10),
        includedBytes: 10,
        originalBytes: fullBytes.byteLength,
        truncated: true,
      }),
    ]);
  });
});
