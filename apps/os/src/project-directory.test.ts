import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listProjectDirectory,
  primeProjectDirectory,
  readProjectById,
  readProjectBySlug,
  type ProjectDirectoryRecord,
} from "./project-directory.ts";

const auth = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getProjectBySlug: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("./env.ts", () => ({ itxEnv: { AUTH: auth } }));

const record: ProjectDirectoryRecord = {
  id: "prj_alpha",
  slug: "alpha",
  organizationId: null,
  name: "Alpha",
};

function directoryWithPut(put: ReturnType<typeof vi.fn>): KVNamespace {
  return { put } as unknown as KVNamespace;
}

function expiringDirectory(): KVNamespace {
  const entries = new Map<string, { expiresAt: number; value: string }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as ProjectDirectoryRecord;
    }),
    put: vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
      entries.set(key, {
        expiresAt: Date.now() + (options?.expirationTtl ?? 0) * 1_000,
        value,
      });
    }),
  } as unknown as KVNamespace;
}

describe("primeProjectDirectory", () => {
  beforeEach(() => {
    auth.getProjectById.mockReset();
    auth.getProjectBySlug.mockReset();
    auth.listProjects.mockReset();
  });

  it("writes both durable lookup keys", async () => {
    const put = vi.fn().mockResolvedValue(undefined);

    await primeProjectDirectory(directoryWithPut(put), record);

    const body = JSON.stringify(record);
    expect(put.mock.calls).toEqual([
      ["slug:alpha", body, { expirationTtl: 60 }],
      ["project:prj_alpha", body, { expirationTtl: 60 }],
    ]);
  });

  it("does not retry a timed-out cache write after auth has registered the project", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejectLate: Array<(error: Error) => void> = [];
      const put = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate.push(reject);
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate.push(reject);
            }),
        );
      const primed = primeProjectDirectory(directoryWithPut(put), record);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(primed).resolves.toBeUndefined();

      expect(put).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] cache prime failed; using auth registration",
        expect.objectContaining({ reason: expect.stringContaining("timed out after 1000ms") }),
      );
      for (const reject of rejectLate) reject(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps an immediate cache failure from invalidating auth registration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));

      await expect(primeProjectDirectory(directoryWithPut(put), record)).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] cache prime failed; using auth registration",
        expect.objectContaining({ reason: "KV unavailable" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readProjectBySlug", () => {
  beforeEach(() => {
    auth.getProjectById.mockReset();
    auth.getProjectBySlug.mockReset();
    auth.listProjects.mockReset();
  });

  it("returns the authoritative auth result when its optional cache fill times out", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authRecord = { ...record, id: "prj_auth", slug: "auth-only" };
      auth.getProjectBySlug.mockResolvedValue(authRecord);
      const directory = {
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

  it("refreshes updated auth metadata after the bounded cache entry expires", async () => {
    vi.useFakeTimers();
    try {
      const original = { ...record, id: "prj_refresh", slug: "refresh", name: "Original" };
      const updated = { ...original, name: "Updated" };
      const directory = expiringDirectory();
      auth.getProjectBySlug.mockResolvedValue(updated);

      await primeProjectDirectory(directory, original);
      await expect(readProjectBySlug(directory, original.slug)).resolves.toEqual(original);

      await vi.advanceTimersByTimeAsync(60_001);

      await expect(readProjectBySlug(directory, original.slug)).resolves.toEqual(updated);
      expect(auth.getProjectBySlug).toHaveBeenCalledWith({ projectSlug: original.slug });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a deleted auth project after the bounded cache entry expires", async () => {
    vi.useFakeTimers();
    try {
      const deleted = { ...record, id: "prj_deleted", slug: "deleted" };
      const directory = expiringDirectory();
      auth.getProjectBySlug.mockResolvedValue(null);

      await primeProjectDirectory(directory, deleted);
      await expect(readProjectBySlug(directory, deleted.slug)).resolves.toEqual(deleted);

      await vi.advanceTimersByTimeAsync(60_001);

      await expect(readProjectBySlug(directory, deleted.slug)).resolves.toBeNull();
      expect(auth.getProjectBySlug).toHaveBeenCalledWith({ projectSlug: deleted.slug });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the old alias and resolves the new alias after an auth rename", async () => {
    vi.useFakeTimers();
    try {
      const original = { ...record, id: "prj_renamed", slug: "before-rename" };
      const renamed = { ...original, slug: "after-rename" };
      const directory = expiringDirectory();
      auth.getProjectBySlug.mockImplementation(async ({ projectSlug }: { projectSlug: string }) =>
        projectSlug === renamed.slug ? renamed : null,
      );

      await primeProjectDirectory(directory, original);
      await expect(readProjectBySlug(directory, original.slug)).resolves.toEqual(original);

      await vi.advanceTimersByTimeAsync(60_001);

      await expect(readProjectBySlug(directory, original.slug)).resolves.toBeNull();
      await expect(readProjectBySlug(directory, renamed.slug)).resolves.toEqual(renamed);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readProjectById", () => {
  beforeEach(() => {
    auth.getProjectById.mockReset();
    auth.getProjectBySlug.mockReset();
    auth.listProjects.mockReset();
  });

  it("falls through a KV miss to auth and fills both cache keys", async () => {
    const authRecord = { ...record, id: "prj_auth", slug: "auth-by-id" };
    auth.getProjectById.mockResolvedValue(authRecord);
    const directory = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;

    await expect(readProjectById(directory, authRecord.id)).resolves.toEqual(authRecord);

    expect(directory.get).toHaveBeenCalledWith("project:prj_auth", "json");
    expect(auth.getProjectById).toHaveBeenCalledWith({ projectId: "prj_auth" });
    const body = JSON.stringify(authRecord);
    expect(directory.put).toHaveBeenCalledWith("slug:auth-by-id", body, { expirationTtl: 60 });
    expect(directory.put).toHaveBeenCalledWith("project:prj_auth", body, { expirationTtl: 60 });
  });
});

describe("listProjectDirectory", () => {
  beforeEach(() => {
    auth.getProjectById.mockReset();
    auth.getProjectBySlug.mockReset();
    auth.listProjects.mockReset();
  });

  it("lists the authoritative auth directory instead of cache contents", async () => {
    auth.listProjects.mockResolvedValue([
      { ...record, metadata: {}, archivedAt: null },
      {
        id: "prj_owned",
        slug: "owned",
        organizationId: "org_one",
        name: "Owned",
        metadata: {},
        archivedAt: null,
      },
    ]);

    await expect(listProjectDirectory({ limit: 25 })).resolves.toEqual([
      record,
      { id: "prj_owned", slug: "owned", organizationId: "org_one", name: "Owned" },
    ]);
    expect(auth.listProjects).toHaveBeenCalledWith({ limit: 25 });
  });
});
