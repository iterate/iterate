import { readFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, test, vi } from "vitest";
import { runCloudflareCommandWith429Retry, runAsync, smokeResponse } from "./deploy-helpers.ts";

// ── runAsync ──
test("resolves only after the child exits successfully", async () => {
  await expect(
    runAsync(process.execPath, ["--eval", "process.exit(0)"], { cwd: process.cwd() }),
  ).resolves.toBeUndefined();
});

test("rejects a nonzero child exit", async () => {
  await expect(
    runAsync(process.execPath, ["--eval", "process.exit(7)"], { cwd: process.cwd() }),
  ).rejects.toThrow("exited with 7");
});

// ── runCloudflareCommandWith429Retry ──
test("retries an explicit Wrangler 429 and then succeeds", async () => {
  using directory = temporaryDirectory();
  const attemptFile = join(directory.path, "attempts");
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
});

test.for([
  {
    name: "a non-429 failure is not retried",
    stderr: "500 Internal Server Error",
    exit: 7,
    sleeps: [],
  },
  {
    name: "a recovered 429 is not retried when a later unrelated error ends the command",
    stderr: "429 Too Many Requests\nERROR\n500 Internal Server Error",
    exit: 7,
    sleeps: [],
  },
  {
    name: "the last 429 fails once the bounded attempts are spent",
    stderr: "429 Too Many Requests",
    exit: 1,
    sleeps: [1, 1],
  },
])("$name", async ({ stderr, exit, sleeps }) => {
  const sleep = vi.fn(async (_ms: number) => {});

  await expect(
    runCloudflareCommandWith429Retry(
      process.execPath,
      ["--eval", `console.error(${JSON.stringify(stderr)}); process.exit(${exit})`],
      { cwd: process.cwd() },
      { backoffMs: [1, 1], sleep },
    ),
  ).rejects.toThrow(`exited with ${exit}`);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(sleeps);
});

// ── smokeResponse ──
test("can require an exact response body rather than trusting the status alone", async () => {
  const fetchMock = vi.fn(async () => Response.json({ error: "not found" }, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    smokeResponse(
      "https://auth-rpc-smoke.example.test/",
      async (response) => {
        const body = (await response.json()) as { error?: unknown };
        return response.status === 404 && body.error === "not found";
      },
      "auth Workers RPC",
    ),
  ).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenCalledOnce();
});
