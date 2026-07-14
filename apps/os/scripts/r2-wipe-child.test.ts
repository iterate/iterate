import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type DeletableR2Bucket, terminateR2WipeProcessGroup } from "./r2-wipe.ts";
import {
  armR2WipeChildWatchdog,
  type RemoteR2ProxyFactory,
  serializeR2WipeError,
  wipeR2FromChild,
} from "./r2-wipe-child.ts";

function oneObjectBucket(deleteObject: () => Promise<void>): DeletableR2Bucket {
  let exists = true;
  return {
    async list() {
      return { objects: exists ? [{ key: "object" }] : [], truncated: false };
    },
    async delete() {
      await deleteObject();
      exists = false;
    },
  };
}

describe("wipeR2FromChild", () => {
  it("waits for every user-data bucket before disposing the proxy", async () => {
    const searchDeleteStarted = Promise.withResolvers<void>();
    const releaseSearchDelete = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {});
    const createProxy: RemoteR2ProxyFactory = async () => ({
      env: {
        FILES_BUCKET: oneObjectBucket(async () => {}),
        SANDBOX_BUCKET: oneObjectBucket(async () => {}),
        SEARCH_BUCKET: oneObjectBucket(async () => {
          searchDeleteStarted.resolve();
          await releaseSearchDelete.promise;
        }),
      },
      dispose,
    });

    const wipe = wipeR2FromChild("wrangler.json", createProxy);
    await searchDeleteStarted.promise;
    expect(dispose).not.toHaveBeenCalled();
    releaseSearchDelete.resolve();

    await expect(wipe).resolves.toEqual({
      filesObjectsDeleted: 1,
      sandboxObjectsDeleted: 1,
      searchObjectsDeleted: 1,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails before deletion if Wrangler exposes a control-plane credential", async () => {
    const files = oneObjectBucket(async () => {});
    const dispose = vi.fn(async () => {});
    const createProxy: RemoteR2ProxyFactory = async () => ({
      env: {
        FILES_BUCKET: files,
        SANDBOX_BUCKET: oneObjectBucket(async () => {}),
        SEARCH_BUCKET: oneObjectBucket(async () => {}),
        CLOUDFLARE_API_TOKEN: "must-not-bind",
      },
      dispose,
    });

    await expect(wipeR2FromChild("wrangler.json", createProxy)).rejects.toThrow(
      "control-plane credentials",
    );
    await expect(files.list({ limit: 1000 })).resolves.toMatchObject({
      objects: [{ key: "object" }],
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("preserves both the operation and disposal failures", async () => {
    const createProxy: RemoteR2ProxyFactory = async () => ({
      env: {
        FILES_BUCKET: oneObjectBucket(async () => {
          throw new Error("delete failed");
        }),
        SANDBOX_BUCKET: oneObjectBucket(async () => {}),
        SEARCH_BUCKET: oneObjectBucket(async () => {}),
      },
      dispose: vi.fn(async () => {
        throw new Error("dispose failed");
      }),
    });

    const error = await wipeR2FromChild("wrangler.json", createProxy).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "delete failed" }),
      expect.objectContaining({ message: "dispose failed" }),
    ]);
  });
});

describe("serializeR2WipeError", () => {
  it("retains nested aggregate causes while redacting the API token", () => {
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "secret-token";
    try {
      const error = new AggregateError(
        [
          new Error("files failed with secret-token"),
          new Error("authorization: Bearer transformed-token"),
        ],
        "both buckets failed",
      );

      expect(serializeR2WipeError(error)).toEqual({
        message: "both buckets failed",
        causes: ["files failed with [REDACTED]", "authorization: Bearer [REDACTED]"],
      });
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    }
  });
});

describe("armR2WipeChildWatchdog", () => {
  it("terminates on an unexpected IPC disconnect", () => {
    const listeners = new Map<string, () => void>();
    const childProcess = {
      connected: true,
      pid: 42,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return childProcess;
      }),
      off: vi.fn(() => childProcess),
    };
    const terminate = vi.fn();

    const watchdog = armR2WipeChildWatchdog({
      childProcess: childProcess as never,
      terminate,
      timeoutMs: 10_000,
    });
    listeners.get("disconnect")?.();
    watchdog.complete();

    expect(terminate).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("terminates immediately when the IPC channel was already disconnected", () => {
    const listeners = new Map<string, () => void>();
    const childProcess = {
      connected: false,
      pid: 42,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return childProcess;
      }),
      off: vi.fn(() => childProcess),
    };
    const terminate = vi.fn();

    const watchdog = armR2WipeChildWatchdog({
      childProcess: childProcess as never,
      terminate,
      timeoutMs: 10_000,
    });
    listeners.get("SIGHUP")?.();
    watchdog.complete();

    expect(terminate).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.skipIf(process.platform === "win32")(
    "kills its detached wrapper and descendant when the parent IPC channel closes",
    async () => {
      const fixturePath = fileURLToPath(
        new URL("./test-fixtures/r2-wipe-watchdog.ts", import.meta.url),
      );
      const child = fork(fixturePath, [], {
        detached: true,
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      try {
        const [message] = (await once(child, "message", {
          signal: AbortSignal.timeout(5_000),
        })) as [{ descendantPid: number }];
        const childExit = once(child, "exit");

        child.disconnect();
        await childExit;

        await vi.waitFor(() => {
          const status = spawnSync("ps", ["-o", "stat=", "-p", String(message.descendantPid)], {
            encoding: "utf8",
          });
          expect(status.stdout.trim() === "" || status.stdout.trim().startsWith("Z")).toBe(true);
        });
      } finally {
        if (child.pid !== undefined) terminateR2WipeProcessGroup(child.pid);
      }
    },
  );
});
