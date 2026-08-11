import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  primeProjectDirectory,
  readProjectBySlug,
  readProjectBySlugAuthoritative,
  type ProjectDirectoryRecord,
} from "./project-directory.ts";

const auth = vi.hoisted(() => ({ getProjectBySlug: vi.fn() }));
vi.mock("./env.ts", () => ({ itxEnv: { AUTH: auth } }));

const record: ProjectDirectoryRecord = {
  id: "prj_alpha",
  slug: "alpha",
  organizationId: null,
  name: "Alpha",
};

function directoryWithPut(
  put: ReturnType<typeof vi.fn>,
  deleteKey = vi.fn().mockResolvedValue(undefined),
): KVNamespace {
  return { delete: deleteKey, put } as unknown as KVNamespace;
}

describe("primeProjectDirectory", () => {
  beforeEach(() => auth.getProjectBySlug.mockReset());

  it("writes both durable lookup keys and clears a stale shared miss", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const deleteKey = vi.fn().mockResolvedValue(undefined);

    await primeProjectDirectory(directoryWithPut(put, deleteKey), record);

    const body = JSON.stringify(record);
    expect(put.mock.calls).toEqual([
      ["slug:alpha", body],
      ["project:prj_alpha", body],
    ]);
    expect(deleteKey).toHaveBeenCalledExactlyOnceWith("missing-slug:alpha");
  });

  it("bounds stale-miss cleanup without failing the required writes", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let rejectLate!: (error: Error) => void;
      const deleteKey = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const put = vi.fn().mockResolvedValue(undefined);
      const primed = primeProjectDirectory(directoryWithPut(put, deleteKey), record);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(primed).resolves.toBeUndefined();
      expect(put.mock.calls.map(([key]) => key)).toEqual(["slug:alpha", "project:prj_alpha"]);
      expect(deleteKey).toHaveBeenCalledExactlyOnceWith("missing-slug:alpha");
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] stale negative marker cleanup failed; positive write remains authoritative",
        expect.objectContaining({ reason: expect.stringContaining("timed out after 1000ms") }),
      );

      rejectLate(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries only the timed-out key and observes its late rejection", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejectLate: Array<(error: Error) => void> = [];
      let slugAttempts = 0;
      const put = vi.fn((key: string) => {
        if (key === "slug:alpha" && slugAttempts++ === 0) {
          return new Promise<void>((_resolve, reject) => {
            rejectLate.push(reject);
          });
        }
        return Promise.resolve();
      });
      const primed = primeProjectDirectory(directoryWithPut(put), record);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(primed).resolves.toBeUndefined();

      expect(put.mock.calls.map(([key]) => key)).toEqual([
        "slug:alpha",
        "project:prj_alpha",
        "slug:alpha",
      ]);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] write failed; retrying",
        expect.objectContaining({ attempt: 1, keyKind: "slug", maxAttempts: 2 }),
      );
      for (const reject of rejectLate) reject(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry a successful sibling when the other key rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn((key: string) =>
        key === "slug:alpha" ? Promise.reject(new Error("KV unavailable")) : Promise.resolve(),
      );

      await expect(primeProjectDirectory(directoryWithPut(put), record)).rejects.toThrow(
        "Project directory slug write failed after 2 attempts: KV unavailable",
      );
      expect(put.mock.calls.map(([key]) => key)).toEqual([
        "slug:alpha",
        "project:prj_alpha",
        "slug:alpha",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("recovers when both keys independently time out once", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const attempts = new Map<string, number>();
      const put = vi.fn((key: string) => {
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return attempt === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      });
      const primed = primeProjectDirectory(directoryWithPut(put), record);

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(primed).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("observes every late rejection after independent timeouts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejectLate: Array<(error: Error) => void> = [];
      const put = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLate.push(reject);
          }),
      );
      const primed = primeProjectDirectory(directoryWithPut(put), record);
      const rejected = expect(primed).rejects.toThrow(
        "Project directory slug write failed after 2 attempts: Project directory KV write timed out after 10000ms",
      );

      await vi.advanceTimersByTimeAsync(20_000);

      await rejected;
      expect(put).toHaveBeenCalledTimes(4);
      for (const reject of rejectLate) reject(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("readProjectBySlug", () => {
  beforeEach(() => auth.getProjectBySlug.mockReset());

  it("shares an authoritative miss through bounded KV without another auth RPC", async () => {
    const get = vi.fn(async (key: string) =>
      key === "missing-slug:shared-miss" ? "missing" : null,
    );
    const directory = { get, put: vi.fn() } as unknown as KVNamespace;

    await expect(readProjectBySlug(directory, "shared-miss")).resolves.toBeNull();

    expect(get.mock.calls).toEqual([["slug:shared-miss", "json"], ["missing-slug:shared-miss"]]);
    expect(auth.getProjectBySlug).not.toHaveBeenCalled();
  });

  it("checks the positive directory key before a shared miss marker", async () => {
    const positive = { ...record, id: "prj_late", slug: "late-positive" };
    const get = vi.fn(async (key: string) => (key === "slug:late-positive" ? positive : "missing"));
    const directory = { get, put: vi.fn() } as unknown as KVNamespace;

    await expect(readProjectBySlug(directory, positive.slug)).resolves.toEqual(positive);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("slug:late-positive", "json");
    expect(auth.getProjectBySlug).not.toHaveBeenCalled();
  });

  it("lets a later positive KV prime outrank this isolate's negative memo", async () => {
    const positive = { ...record, id: "prj_just_created", slug: "just-created" };
    let created = false;
    const get = vi.fn(async (key: string) =>
      key === "slug:just-created" && created ? positive : null,
    );
    auth.getProjectBySlug.mockResolvedValue(null);
    const directory = {
      get,
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;

    await expect(readProjectBySlug(directory, positive.slug)).resolves.toBeNull();
    created = true;
    await expect(readProjectBySlug(directory, positive.slug)).resolves.toEqual(positive);

    expect(auth.getProjectBySlug).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenLastCalledWith("slug:just-created", "json");
  });

  it("writes a bounded shared marker after an authoritative miss", async () => {
    auth.getProjectBySlug.mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    const directory = {
      get: vi.fn().mockResolvedValue(null),
      put,
    } as unknown as KVNamespace;

    await expect(readProjectBySlug(directory, "new-miss")).resolves.toBeNull();

    expect(auth.getProjectBySlug).toHaveBeenCalledWith({ projectSlug: "new-miss" });
    expect(put).toHaveBeenCalledWith("missing-slug:new-miss", "missing", {
      expirationTtl: 60,
    });
  });

  it("returns the authoritative auth result when its optional cache fill times out", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authRecord = { ...record, id: "prj_auth", slug: "auth-only" };
      auth.getProjectBySlug.mockResolvedValue(authRecord);
      const directory = {
        delete: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(() => new Promise<void>(() => {})),
      } as unknown as KVNamespace;
      const reading = readProjectBySlug(directory, authRecord.slug);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(reading).resolves.toEqual(authRecord);
      expect(directory.get).toHaveBeenCalledWith("slug:auth-only", "json");
      expect(auth.getProjectBySlug).toHaveBeenCalledWith({ projectSlug: "auth-only" });
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] cache fill failed; using auth result",
        expect.objectContaining({ reason: expect.stringContaining("timed out after 1000ms") }),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("readProjectBySlugAuthoritative", () => {
  beforeEach(() => auth.getProjectBySlug.mockReset());

  it("re-primes a stale positive cache entry from the auth answer", async () => {
    const stale = { id: "prj_dead", slug: "reborn", organizationId: null, name: "reborn" };
    const fresh = { id: "prj_live", slug: "reborn", organizationId: "org_new", name: "reborn" };
    const directory = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(stale),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;

    // The cached read path serves the stale record — the bug this heals.
    await expect(readProjectBySlug(directory, "reborn")).resolves.toEqual(stale);

    auth.getProjectBySlug.mockResolvedValue(fresh);
    await expect(readProjectBySlugAuthoritative(directory, "reborn")).resolves.toEqual(fresh);
    expect(auth.getProjectBySlug).toHaveBeenCalledExactlyOnceWith({ projectSlug: "reborn" });
    expect((directory.put as ReturnType<typeof vi.fn>).mock.calls.map(([key]) => key)).toEqual([
      "slug:reborn",
      "project:prj_live",
    ]);

    // The heal refreshes the in-isolate memo too: cached reads now serve the
    // live record without waiting for KV visibility.
    await expect(readProjectBySlug(directory, "reborn")).resolves.toEqual(fresh);
  });

  it("returns null and writes nothing when auth has no row (admin-lane projects stay cached)", async () => {
    auth.getProjectBySlug.mockResolvedValue(null);
    const directory = {
      delete: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
    } as unknown as KVNamespace;

    await expect(readProjectBySlugAuthoritative(directory, "kv-only")).resolves.toBeNull();
    expect(directory.put).not.toHaveBeenCalled();
    expect(directory.delete).not.toHaveBeenCalled();
  });

  it("still returns the auth record when the re-prime fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = { id: "prj_live2", slug: "reborn-2", organizationId: null, name: "reborn-2" };
      auth.getProjectBySlug.mockResolvedValue(fresh);
      const directory = {
        delete: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      } as unknown as KVNamespace;

      await expect(readProjectBySlugAuthoritative(directory, "reborn-2")).resolves.toEqual(fresh);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] authoritative re-prime failed; using auth result",
        expect.objectContaining({ reason: expect.stringContaining("KV unavailable") }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
