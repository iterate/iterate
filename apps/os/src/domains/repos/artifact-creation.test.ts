import { expect, test, vi } from "vitest";
import { getOrCreateArtifact } from "./artifact-creation.ts";

test("an existing seeded repo reports its branch head", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({
      log: vi.fn(async () => [{ hash: "a".repeat(40) }]),
    })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({
    branchState: "has-commits",
    created: false,
    initialWriteToken: null,
  });
});

test("a new repo preserves create's initial write token without reading it back", async () => {
  const artifacts = {
    create: vi.fn(async () => ({
      token: "art_v1_initial?expires=1760000000",
    })),
    get: vi.fn(),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "trunk",
  });

  expect(result).toEqual({
    branchState: "empty",
    created: true,
    initialWriteToken: "art_v1_initial",
  });
  expect(artifacts.create).toHaveBeenCalledExactlyOnceWith("project-repo", {
    setDefaultBranch: "trunk",
  });
  expect(artifacts.get).not.toHaveBeenCalled();
});

test("an existing repo without a branch remains eligible for recovery", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    // The deployed Workers binding returns a repo handle, not REST metadata:
    // lastPushAt can be absent even though TypeScript's beta surface exposed it.
    get: vi.fn(async () => ({
      log: vi.fn(async () => []),
    })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({
    branchState: "empty",
    created: false,
    initialWriteToken: null,
  });
});

test("a missing default branch remains eligible for recovery", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({
      log: vi.fn(async () => {
        throw Object.assign(new Error("Could not find main."), { code: "NotFoundError" });
      }),
    })),
  };

  await expect(
    getOrCreateArtifact(artifacts, "project-repo", { defaultBranch: "main" }),
  ).resolves.toEqual({
    branchState: "empty",
    created: false,
    initialWriteToken: null,
  });
});

test("branch verification shares the creation recovery deadline", async () => {
  vi.useFakeTimers();
  try {
    const artifacts = {
      create: vi.fn(async () => {
        throw artifactError("ALREADY_EXISTS");
      }),
      get: vi.fn(async () => ({
        log: vi.fn(() => new Promise<never>(() => undefined)),
      })),
    };

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "RepoNotSeededError" });
    await vi.advanceTimersByTimeAsync(8_000);

    await rejection;
  } finally {
    vi.useRealTimers();
  }
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
        .mockResolvedValueOnce({ log: vi.fn(async () => []) }),
    };

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      branchState: "empty",
      created: false,
      initialWriteToken: null,
    });
    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.get).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("an ambiguous create waits for get to return a complete repo handle", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi
      .fn()
      .mockResolvedValueOnce({ name: "project-repo" })
      .mockResolvedValueOnce({ log: vi.fn(async () => []) }),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({
    branchState: "empty",
    created: false,
    initialWriteToken: null,
  });
  expect(artifacts.get).toHaveBeenCalledTimes(2);
});

test("an existing control-plane repo handle defers branch verification to the git remote", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({
      createToken: vi.fn(async () => ({ plaintext: "art_v1_recovery" })),
    })),
  };

  await expect(
    getOrCreateArtifact(artifacts, "project-repo", { defaultBranch: "main" }),
  ).resolves.toEqual({
    branchState: "requires-clone",
    created: false,
    initialWriteToken: null,
  });
  expect(artifacts.get).toHaveBeenCalledOnce();
});

test("a stalled create returns to durable recovery before the hosted callback deadline", async () => {
  vi.useFakeTimers();
  try {
    const artifacts = {
      create: vi.fn(() => new Promise<never>(() => undefined)),
      get: vi.fn(),
    };

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    const settled = vi.fn();
    void result.then(settled, settled);
    const rejection = expect(result).rejects.toMatchObject({
      name: "RetryableRepoCreationError",
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.get).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("create and ambiguous-create readback share one recovery deadline", async () => {
  vi.useFakeTimers();
  try {
    const artifacts = {
      create: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(artifactError("ALREADY_EXISTS")), 7_000);
          }),
      ),
      get: vi.fn(async () => {
        throw artifactError("NOT_FOUND");
      }),
    };
    const startedAt = Date.now();

    const result = getOrCreateArtifact(artifacts, "project-repo", {
      defaultBranch: "main",
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "RepoNotSeededError",
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(Date.now() - startedAt).toBe(8_000);
    expect(artifacts.create).toHaveBeenCalledOnce();
    expect(artifacts.get.mock.calls.length).toBeGreaterThan(1);
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
