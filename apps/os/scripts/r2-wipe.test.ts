import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  deleteAllR2Objects,
  type DeletableR2Bucket,
  type R2WipeChildRunner,
  r2WipeChildEnvironment,
  terminateR2WipeProcessTree,
  waitForR2WipeSubprocess,
  wipeRemoteUserDataBuckets,
} from "./r2-wipe.ts";

class FakeSubprocess extends EventEmitter {
  connected = true;
  pid = 42;
  readonly unref = vi.fn();

  disconnect() {
    this.connected = false;
  }

  kill() {
    return true;
  }
}

function memoryBucket(initialKeys: string[]) {
  const keys = new Set(initialKeys);
  const deleteBatches: string[][] = [];
  const bucket: DeletableR2Bucket = {
    async list({ limit }) {
      const objects = [...keys]
        .sort()
        .slice(0, limit)
        .map((key) => ({ key }));
      return { objects, truncated: keys.size > objects.length };
    },
    async delete(batch) {
      deleteBatches.push(batch);
      for (const key of batch) keys.delete(key);
    },
  };
  return { bucket, deleteBatches, keys };
}

describe("deleteAllR2Objects", () => {
  it("bulk-deletes and re-lists until the bucket is empty", async () => {
    const state = memoryBucket(Array.from({ length: 2_501 }, (_, index) => `key-${index}`));

    await expect(deleteAllR2Objects(state.bucket)).resolves.toBe(2_501);

    expect(state.deleteBatches.map((batch) => batch.length)).toEqual([1000, 1000, 501]);
    expect(state.keys.size).toBe(0);
  });

  it("fails closed on an empty truncated listing", async () => {
    const bucket: DeletableR2Bucket = {
      list: vi.fn(async () => ({ objects: [], truncated: true })),
      delete: vi.fn(async () => {}),
    };

    await expect(deleteAllR2Objects(bucket)).rejects.toThrow("partial wipe");
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

describe("r2WipeChildEnvironment", () => {
  it("passes only execution essentials and explicitly disables process-env bindings", () => {
    const environment = r2WipeChildEnvironment(
      { accountId: "selected-account", apiToken: "selected-token" },
      {
        CI: "true",
        HOME: "/home/runner",
        PATH: "/usr/bin",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
        DOPPLER_TOKEN: "must-not-pass",
        NODE_OPTIONS: "--import=must-not-pass",
      },
    );

    expect(environment).toEqual({
      CI: "true",
      HOME: "/home/runner",
      PATH: "/usr/bin",
      CLOUDFLARE_ACCOUNT_ID: "selected-account",
      CLOUDFLARE_API_TOKEN: "selected-token",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
    });
  });
});

describe("waitForR2WipeSubprocess", () => {
  it("accepts a clean result and terminates any residual process group", async () => {
    const child = new FakeSubprocess();
    const terminate = vi.fn();
    const result = waitForR2WipeSubprocess(child, { terminate, timeoutMs: 10_000 });

    child.emit("message", {
      type: "success",
      filesObjectsDeleted: 2,
      sandboxObjectsDeleted: 4,
      searchObjectsDeleted: 3,
    });
    child.emit("exit", 0, null);

    await expect(result).resolves.toEqual({
      filesObjectsDeleted: 2,
      sandboxObjectsDeleted: 4,
      searchObjectsDeleted: 3,
    });
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("rejects immediately on an error even when exit never follows", async () => {
    const child = new FakeSubprocess();
    const terminate = vi.fn();
    const result = waitForR2WipeSubprocess(child, { terminate, timeoutMs: 10_000 });

    child.emit("error", new Error("spawn failed"));

    await expect(result).rejects.toThrow("failed to start");
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child);
    expect(child.connected).toBe(false);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("preserves structured child failure causes", async () => {
    const child = new FakeSubprocess();
    const result = waitForR2WipeSubprocess(child, { terminate: vi.fn(), timeoutMs: 10_000 });

    child.emit("message", {
      type: "error",
      message: "Both R2 user-data bucket wipes failed.",
      causes: ["files delete failed", "search delete failed"],
    });
    child.emit("exit", 1, null);

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("Both R2 user-data bucket wipes failed");
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "files delete failed" }),
      expect.objectContaining({ message: "search delete failed" }),
    ]);
  });

  it("preserves both timeout and process-tree termination failures", async () => {
    const child = new FakeSubprocess();
    const terminationFailure = new Error("kill failed");
    const result = waitForR2WipeSubprocess(child, {
      terminate: () => {
        throw terminationFailure;
      },
      timeoutMs: 1,
    });

    const error = await result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("exceeded 1ms") }),
      terminationFailure,
    ]);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")(
    "leaves no referenced output pipes when process-tree termination fails",
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const childExit = once(child, "exit");

      try {
        expect(child.stdout).toBeNull();
        expect(child.stderr).toBeNull();

        await expect(
          waitForR2WipeSubprocess(child, {
            terminate: () => {
              throw new Error("simulated process-tree termination failure");
            },
            timeoutMs: 1,
          }),
        ).rejects.toThrow("Process-tree termination also failed");
        expect(child.connected).toBe(false);
      } finally {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        await childExit;
      }
    },
  );
});

describe("terminateR2WipeProcessTree", () => {
  it.skipIf(process.platform === "win32")(
    "kills a detached wrapper and its descendant process",
    async () => {
      const wrapper = spawn(
        process.execPath,
        [
          "-e",
          [
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            'process.stdout.write(String(child.pid) + "\\n");',
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const wrapperExit = once(wrapper, "exit");
      let descendantPid: number | undefined;

      try {
        const [pidOutput] = await once(wrapper.stdout, "data", {
          signal: AbortSignal.timeout(5_000),
        });
        descendantPid = Number.parseInt(String(pidOutput).trim(), 10);
        terminateR2WipeProcessTree(wrapper);
        await wrapperExit;

        await vi.waitFor(() => {
          const status = spawnSync("ps", ["-o", "stat=", "-p", String(descendantPid)], {
            encoding: "utf8",
          });
          expect(status.stdout.trim() === "" || status.stdout.trim().startsWith("Z")).toBe(true);
        });
      } finally {
        if (wrapper.pid !== undefined) {
          try {
            process.kill(-wrapper.pid, "SIGKILL");
          } catch {}
        }
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );
});

describe("wipeRemoteUserDataBuckets", () => {
  it("writes only remote R2 bindings, delegates to the child, and removes the config", async () => {
    let temporaryConfigPath = "";
    let config: unknown;
    const runChild: R2WipeChildRunner = async (input) => {
      temporaryConfigPath = input.configPath;
      config = JSON.parse(await readFile(input.configPath, "utf8"));
      expect(input).toMatchObject({ accountId: "account-id", apiToken: "api-token" });
      return { filesObjectsDeleted: 2, sandboxObjectsDeleted: 3, searchObjectsDeleted: 1 };
    };

    await expect(
      wipeRemoteUserDataBuckets(
        {
          accountId: "account-id",
          apiToken: "api-token",
          compatibilityDate: "2026-07-13",
          workerName: "os-preview-2",
        },
        { runChild },
      ),
    ).resolves.toEqual([
      { bucketName: "os-preview-2-files", objectsDeleted: 2 },
      { bucketName: "os-preview-2-sandboxes", objectsDeleted: 3 },
      { bucketName: "os-preview-2-search-index", objectsDeleted: 1 },
    ]);

    expect(config).toEqual({
      name: "os-preview-2-r2-wipe",
      account_id: "account-id",
      compatibility_date: "2026-07-13",
      r2_buckets: [
        { binding: "FILES_BUCKET", bucket_name: "os-preview-2-files", remote: true },
        {
          binding: "SANDBOX_BUCKET",
          bucket_name: "os-preview-2-sandboxes",
          remote: true,
        },
        {
          binding: "SEARCH_BUCKET",
          bucket_name: "os-preview-2-search-index",
          remote: true,
        },
      ],
    });
    expect(JSON.stringify(config)).not.toContain("api-token");
    await expect(access(temporaryConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its temporary config when the child fails", async () => {
    let temporaryConfigPath = "";
    const runChild: R2WipeChildRunner = async (input) => {
      temporaryConfigPath = input.configPath;
      throw new Error("child failed");
    };

    await expect(
      wipeRemoteUserDataBuckets(
        {
          accountId: "account-id",
          apiToken: "api-token",
          compatibilityDate: "2026-07-13",
          workerName: "os-preview-2",
        },
        { runChild },
      ),
    ).rejects.toThrow("child failed");
    await expect(access(temporaryConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves both child and temporary-config cleanup failures", async () => {
    const childFailure = new Error("child failed");
    const cleanupFailure = new Error("cleanup failed");

    const error = await wipeRemoteUserDataBuckets(
      {
        accountId: "account-id",
        apiToken: "api-token",
        compatibilityDate: "2026-07-13",
        workerName: "os-preview-2",
      },
      {
        runChild: async () => {
          throw childFailure;
        },
        removeTemporaryDirectory: async () => {
          throw cleanupFailure;
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([childFailure, cleanupFailure]);
  });
});
