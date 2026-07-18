import { describe, expect, it, vi } from "vitest";
import { StreamAlarm } from "./stream-alarm.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("StreamAlarm", () => {
  it("serializes competing arms so the earliest deadline wins", async () => {
    const firstWrite = deferred<void>();
    let persisted: number | null = null;
    const setAlarm = vi.fn(async (atMs: number) => {
      if (setAlarm.mock.calls.length === 1) await firstWrite.promise;
      persisted = atMs;
    });
    const kept: Promise<unknown>[] = [];
    const alarm = new StreamAlarm({
      storage: {
        deleteAlarm: async () => {
          persisted = null;
        },
        getAlarm: async () => persisted,
        setAlarm,
      } as Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">,
      keepAlive: (promise) => kept.push(promise),
    });

    const later = alarm.armNoLaterThan(200);
    const earlier = alarm.armNoLaterThan(100);
    await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await Promise.all([later, earlier, ...kept]);

    expect(setAlarm.mock.calls.map(([atMs]) => atMs)).toEqual([200, 100]);
    expect(persisted).toBe(100);
  });

  it("invalidates its cache after failure and retries the platform write", async () => {
    let persisted: number | null = null;
    const getAlarm = vi.fn(async () => persisted);
    const setAlarm = vi
      .fn<(atMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("setAlarm failed"))
      .mockImplementationOnce(async (atMs) => {
        persisted = atMs;
      });
    const alarm = new StreamAlarm({
      storage: {
        deleteAlarm: async () => {
          persisted = null;
        },
        getAlarm,
        setAlarm,
      } as Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">,
      keepAlive: () => undefined,
    });

    await expect(alarm.armNoLaterThan(100)).rejects.toThrow("setAlarm failed");
    await expect(alarm.armNoLaterThan(100)).resolves.toBeUndefined();

    expect(getAlarm).toHaveBeenCalledTimes(2);
    expect(setAlarm).toHaveBeenCalledTimes(2);
    expect(persisted).toBe(100);
  });

  it("repoints exactly and records a consumed alarm", async () => {
    let persisted: number | null = 50;
    const getAlarm = vi.fn(async () => persisted);
    const deleteAlarm = vi.fn(async () => {
      persisted = null;
    });
    const alarm = new StreamAlarm({
      storage: {
        deleteAlarm,
        getAlarm,
        setAlarm: async (atMs) => {
          persisted = typeof atMs === "number" ? atMs : atMs.getTime();
        },
      } as Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">,
      keepAlive: () => undefined,
    });

    await alarm.repoint(null);
    expect(deleteAlarm).toHaveBeenCalledOnce();
    await alarm.fired();
    await alarm.armNoLaterThan(75);
    expect(getAlarm).toHaveBeenCalledTimes(2);
    expect(persisted).toBe(75);
  });

  it("re-reads a successor arm that landed before fired invalidated the cache", async () => {
    const successorWrite = deferred<void>();
    let persisted: number | null = null;
    const getAlarm = vi.fn(async () => persisted);
    const setAlarm = vi.fn(async (atMs: number) => {
      await successorWrite.promise;
      persisted = atMs;
    });
    const alarm = new StreamAlarm({
      storage: {
        deleteAlarm: async () => {
          persisted = null;
        },
        getAlarm,
        setAlarm,
      } as Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">,
      keepAlive: () => undefined,
    });

    const successor = alarm.armNoLaterThan(100);
    const fired = alarm.fired();
    await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledOnce());
    successorWrite.resolve();
    await Promise.all([successor, fired]);

    // fired() invalidated its in-memory view after the successor write. The
    // later request must read storage and preserve 100, not overwrite it with
    // the later 200 deadline.
    await alarm.armNoLaterThan(200);
    expect(getAlarm).toHaveBeenCalledTimes(2);
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(persisted).toBe(100);
  });
});
