import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  primeProjectDirectory,
  readProjectBySlug,
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

  it("recovers from one timed-out attempt and observes its late rejection", async () => {
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
        )
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const primed = primeProjectDirectory(directoryWithPut(put), record);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(primed).resolves.toBeUndefined();

      expect(put).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] write failed; retrying",
        expect.objectContaining({ attempt: 1, maxAttempts: 2 }),
      );
      for (const reject of rejectLate) reject(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects after two failed attempts instead of swallowing the dependency error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));

      await expect(primeProjectDirectory(directoryWithPut(put), record)).rejects.toThrow(
        "Project directory write failed after 2 attempts: KV unavailable",
      );
      expect(put).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects after two bounded attempts when KV never settles", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn(() => new Promise<void>(() => {}));
      const primed = primeProjectDirectory(directoryWithPut(put), record);
      const rejected = expect(primed).rejects.toThrow(
        "Project directory write failed after 2 attempts: Project directory KV write timed out after 10000ms",
      );

      await vi.advanceTimersByTimeAsync(20_000);

      await rejected;
      expect(put).toHaveBeenCalledTimes(4);
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
