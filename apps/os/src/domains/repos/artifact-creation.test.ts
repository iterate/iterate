import { expect, test, vi } from "vitest";
import { getOrCreateArtifact } from "./artifact-creation.ts";

const FAKE_REMOTE = "https://acct.artifacts.cloudflare.net/git/ns/project-repo.git";

test("an existing seeded repo reports its last push", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ remote: FAKE_REMOTE, lastPushAt: "2026-07-20T12:00:00.000Z" })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({
    created: false,
    initialWriteToken: null,
    lastPushAt: "2026-07-20T12:00:00.000Z",
    remote: FAKE_REMOTE,
  });
});

test("a new repo preserves create's initial write token without reading it back", async () => {
  const artifacts = {
    create: vi.fn(async () => ({
      remote: FAKE_REMOTE,
      token: "art_v1_initial?expires=1760000000",
    })),
    get: vi.fn(),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "trunk",
  });

  expect(result).toEqual({
    created: true,
    initialWriteToken: "art_v1_initial",
    lastPushAt: null,
    remote: FAKE_REMOTE,
  });
  expect(artifacts.create).toHaveBeenCalledExactlyOnceWith("project-repo", {
    setDefaultBranch: "trunk",
  });
  expect(artifacts.get).not.toHaveBeenCalled();
});

test("an unseeded existing repo remains eligible for recovery", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ remote: FAKE_REMOTE, lastPushAt: null })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({
    created: false,
    initialWriteToken: null,
    lastPushAt: null,
    remote: FAKE_REMOTE,
  });
});

test("an ambiguous create waits for the existing repo to become readable", async () => {
  vi.useFakeTimers();
  try {
    const artifacts = {
      create: vi.fn(async () => {
        throw artifactError("ALREADY_EXISTS");
      }),
      get: vi
        .fn()
        .mockRejectedValueOnce(artifactError("NOT_FOUND"))
        .mockRejectedValueOnce(artifactError("NOT_FOUND"))
        .mockResolvedValueOnce({ remote: FAKE_REMOTE, lastPushAt: null }),
    };

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      created: false,
      initialWriteToken: null,
      lastPushAt: null,
      remote: FAKE_REMOTE,
    });
    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.get).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("an existing repo that never materializes remains a retryable obligation", async () => {
  vi.useFakeTimers();
  try {
    const artifacts = {
      create: vi.fn(async () => {
        throw artifactError("ALREADY_EXISTS");
      }),
      get: vi.fn(async () => {
        throw artifactError("NOT_FOUND");
      }),
    };

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "RepoNotSeededError",
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.get.mock.calls.length).toBeGreaterThan(1);
  } finally {
    vi.useRealTimers();
  }
});

test("an existing repo does not hide a real Artifacts read failure", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => {
      throw artifactError("INTERNAL_ERROR");
    }),
  };

  await expect(
    getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    }),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  expect(artifacts.get).toHaveBeenCalledOnce();
});

function artifactError(code: string) {
  return Object.assign(new Error(code), { code });
}
