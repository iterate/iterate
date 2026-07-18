import { describe, expect, it, vi } from "vitest";
import { createArtifactWriteToken } from "./artifact-repo-rpc.ts";

function artifactsWithRepo(repo: unknown): Pick<Artifacts, "get"> {
  return {
    get: vi.fn(async () => repo),
  } as unknown as Pick<Artifacts, "get">;
}

describe("createArtifactWriteToken", () => {
  it("preserves a minted token when repository disposal fails", async () => {
    const cleanupError = new Error("dispose failed");
    const createToken = vi.fn(async () => ({ plaintext: "secret?expires=tomorrow" }));
    const repo = Object.assign(
      { createToken },
      {
        [Symbol.dispose]() {
          throw cleanupError;
        },
      },
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(createArtifactWriteToken(artifactsWithRepo(repo), "repo", 123)).resolves.toBe(
        "secret",
      );
      expect(createToken).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith("Artifacts repository RPC result disposal failed", {
        operation: "create write token",
        error: cleanupError,
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("preserves the primary token error when repository disposal also fails", async () => {
    const tokenError = new Error("token mint failed");
    const cleanupError = new Error("dispose failed");
    const repo = Object.assign(
      {
        createToken: vi.fn(async () => {
          throw tokenError;
        }),
      },
      {
        [Symbol.dispose]() {
          throw cleanupError;
        },
      },
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(createArtifactWriteToken(artifactsWithRepo(repo), "repo", 123)).rejects.toBe(
        tokenError,
      );
      expect(errorLog).toHaveBeenCalledWith("Artifacts repository RPC result disposal failed", {
        operation: "create write token",
        error: cleanupError,
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
