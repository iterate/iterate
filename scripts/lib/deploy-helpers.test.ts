import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCloudflareCommandWith429Retry, runAsync, smokeResponse } from "./deploy-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("runAsync", () => {
  it("resolves only after the child exits successfully", async () => {
    await expect(
      runAsync(process.execPath, ["--eval", "process.exit(0)"], { cwd: process.cwd() }),
    ).resolves.toBeUndefined();
  });

  it("rejects a nonzero child exit", async () => {
    await expect(
      runAsync(process.execPath, ["--eval", "process.exit(7)"], { cwd: process.cwd() }),
    ).rejects.toThrow("exited with 7");
  });
});

describe("runCloudflareCommandWith429Retry", () => {
  it("retries an explicit Wrangler 429 and then succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "deploy-command-retry-"));
    const attemptFile = join(directory, "attempts");
    const script = `
      const fs = require("node:fs");
      const file = ${JSON.stringify(attemptFile)};
      const attempts = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
      fs.writeFileSync(file, String(attempts + 1));
      if (attempts === 0) {
        console.error("GET /workers/services/os-preview-7 -> 429 Too Many Requests");
        process.exit(1);
      }
    `;
    const sleep = vi.fn(async () => {});

    try {
      await expect(
        runCloudflareCommandWith429Retry(
          process.execPath,
          ["--eval", script],
          { cwd: process.cwd() },
          { backoffMs: [7], sleep },
        ),
      ).resolves.toBeUndefined();

      expect(readFileSync(attemptFile, "utf8")).toBe("2");
      expect(sleep).toHaveBeenCalledExactlyOnceWith(7);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not retry a non-429 command failure", async () => {
    const sleep = vi.fn(async () => {});

    await expect(
      runCloudflareCommandWith429Retry(
        process.execPath,
        ["--eval", 'console.error("500 Internal Server Error"); process.exit(7)'],
        { cwd: process.cwd() },
        { backoffMs: [1, 1], sleep },
      ),
    ).rejects.toThrow("exited with 7");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a recovered 429 when a later unrelated error terminates the command", async () => {
    const sleep = vi.fn(async () => {});

    await expect(
      runCloudflareCommandWith429Retry(
        process.execPath,
        [
          "--eval",
          'console.error("429 Too Many Requests\\nERROR\\n500 Internal Server Error"); process.exit(7)',
        ],
        { cwd: process.cwd() },
        { backoffMs: [1, 1], sleep },
      ),
    ).rejects.toThrow("exited with 7");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails after the bounded 429 attempt budget is exhausted", async () => {
    const sleep = vi.fn(async () => {});

    await expect(
      runCloudflareCommandWith429Retry(
        process.execPath,
        ["--eval", 'console.error("429 Too Many Requests"); process.exit(1)'],
        { cwd: process.cwd() },
        { backoffMs: [1, 1], sleep },
      ),
    ).rejects.toThrow("exited with 1");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("smokeResponse", () => {
  it("passes request headers and can require an exact response body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const headers = { "CF-Access-Client-Id": "test-client" };

    await expect(
      smokeResponse(
        "https://auth-rpc-smoke.example.test/",
        async (response) => {
          const body = (await response.json()) as { error?: unknown };
          return response.status === 404 && body.error === "not found";
        },
        "auth Workers RPC",
        headers,
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://auth-rpc-smoke.example.test/",
      expect.objectContaining({ headers }),
    );
  });
});
