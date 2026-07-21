import { describe, expect, test, vi } from "vitest";
import {
  importGithubArtifact,
  importGithubArtifactWithInitialPushCapture,
} from "./artifact-import.ts";

function fakeArtifacts() {
  return {
    get: vi.fn(async () => ({}) as ArtifactsRepo),
    import: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
  };
}

describe("importGithubArtifact", () => {
  test("captures the imported head after installing the exact-repo subscription", async () => {
    const order: string[] = [];
    const appended: unknown[] = [];
    const commitOid = "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01";
    const artifacts = {
      import: async () => {
        order.push("import");
        return {} as ArtifactsCreateRepoResult;
      },
      get: async () => {
        order.push("ready");
        return {
          log: async () => {
            order.push("read-head");
            return [{ hash: commitOid }];
          },
        } as unknown as ArtifactsRepo;
      },
    };

    await importGithubArtifactWithInitialPushCapture(
      artifacts,
      {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      },
      {
        append: async (event) => {
          order.push("append-capture");
          appended.push(event);
        },
        ensureEventSubscription: async () => {
          order.push("subscribe");
        },
        namespace: "os-preview-17-repos",
      },
    );

    expect(order).toEqual(["import", "ready", "subscribe", "read-head", "append-capture"]);
    expect(appended).toEqual([
      {
        type: "events.iterate.com/repo/cloudflare-artifact-event-received",
        idempotencyKey: `artifact-import-initial-push:${commitOid}`,
        payload: {
          artifactName: "project--repo",
          body: {
            type: "cf.artifacts.repo.pushed",
            source: {
              namespace: "os-preview-17-repos",
              repoName: "project--repo",
              type: "artifacts.repo",
            },
            payload: {
              after: commitOid,
              before: "0000000000000000000000000000000000000000",
              ref: "refs/heads/main",
            },
          },
          cloudflareEventType: "cf.artifacts.repo.pushed",
          namespace: "os-preview-17-repos",
        },
      },
    ]);
  });

  test("imports the public GitHub URL with full history", async () => {
    const artifacts = fakeArtifacts();

    await importGithubArtifact(artifacts, {
      branch: "main",
      name: "project--repo",
      owner: "iterate",
      repo: "iterate",
    });

    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "project--repo" },
    });
    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("passes an explicit shallow depth to Artifacts", async () => {
    const artifacts = fakeArtifacts();

    await importGithubArtifact(artifacts, {
      branch: "main",
      depth: 1,
      name: "project--repo",
      owner: "iterate",
      repo: "iterate",
    });

    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        depth: 1,
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "project--repo" },
    });
  });

  test("accepts an existing deterministic target on retry", async () => {
    const artifacts = fakeArtifacts();
    artifacts.import.mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      }),
    ).resolves.toBeUndefined();
    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("waits for an existing target whose import is still in progress", async () => {
    vi.useFakeTimers();
    try {
      const artifacts = fakeArtifacts();
      artifacts.import.mockRejectedValueOnce(
        Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
      );
      artifacts.get
        .mockRejectedValueOnce(
          Object.assign(new Error("still importing"), { code: "IMPORT_IN_PROGRESS" }),
        )
        .mockResolvedValueOnce({} as ArtifactsRepo);

      const imported = importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      });
      await vi.runAllTimersAsync();

      await expect(imported).resolves.toBeUndefined();
      expect(artifacts.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("leaves creation retryable when the readiness window expires", async () => {
    vi.useFakeTimers();
    try {
      const artifacts = fakeArtifacts();
      artifacts.import.mockRejectedValueOnce(
        Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
      );
      artifacts.get.mockRejectedValue(
        Object.assign(new Error("still importing"), { code: "IMPORT_IN_PROGRESS" }),
      );

      const imported = importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      });
      const rejection = expect(imported).rejects.toMatchObject({ name: "RepoNotSeededError" });
      await vi.runAllTimersAsync();

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not hide import failures", async () => {
    const artifacts = fakeArtifacts();
    artifacts.import.mockRejectedValueOnce(
      Object.assign(new Error("private repository"), { code: "REMOTE_AUTH_REQUIRED" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "private",
      }),
    ).rejects.toThrow("private repository");
  });
});
