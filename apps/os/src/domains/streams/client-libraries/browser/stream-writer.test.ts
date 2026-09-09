import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireWriterRole } from "./stream-writer.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireWriterRole", () => {
  it("does not release a granted lock until registered writer setup work settles", async () => {
    let lockCallbackFinished = false;
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<void>,
      ): Promise<void> => {
        await callback();
        lockCallbackFinished = true;
      },
    );
    vi.stubGlobal("navigator", { locks: { request } });

    const role = acquireWriterRole({ lockName: "test-writer" });
    await role.whenWriter;
    const setup = deferred();
    role.holdUntil(setup.promise);

    role.release();
    await Promise.resolve();
    expect(lockCallbackFinished).toBe(false);

    setup.resolve(undefined);
    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
  });
});

it("rejects election when Web Locks fails instead of waiting forever", async () => {
  const failure = new Error("locks unavailable");
  vi.stubGlobal("navigator", { locks: { request: vi.fn().mockRejectedValue(failure) } });
  const role = acquireWriterRole({ lockName: "test-writer" });
  await expect(role.whenWriter).rejects.toBe(failure);
  role.release();
});
