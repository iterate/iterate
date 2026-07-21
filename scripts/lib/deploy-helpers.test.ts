import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerSecretAbsent,
  buildR2ObjectExpiryLifecycleRules,
  ensureR2ObjectExpiryLifecycle,
  PREVIEW_DISPOSABLE_TTL_SECONDS,
  PREVIEW_FILES_OBJECT_EXPIRY,
  removeWorkerSecrets,
  runCloudflareCommandWith429Retry,
  runAsync,
  SANDBOX_BACKUP_EXPIRY_RULE,
  SANDBOX_BACKUP_TTL_SECONDS_PRD,
  smokeResponse,
} from "./deploy-helpers.ts";
import { CloudflareApiError } from "./env-context.ts";

afterEach(() => vi.unstubAllGlobals());

const workerName = "os-prd";
const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const listPath = `/workers/scripts/${workerName}/secrets`;

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

describe("assertWorkerSecretAbsent", () => {
  it("accepts a Worker without the forbidden binding", async () => {
    const cf = vi.fn(async () => []);

    await expect(assertWorkerSecretAbsent({ cf, workerName, secretName })).resolves.toBeUndefined();

    expect(cf).toHaveBeenCalledOnce();
    expect(cf).toHaveBeenCalledWith(listPath);
  });

  it("accepts a Worker that has not been created yet", async () => {
    const cf = vi.fn(async () => {
      throw new CloudflareApiError("GET", listPath, 404, [{ code: 10007 }]);
    });

    await expect(assertWorkerSecretAbsent({ cf, workerName, secretName })).resolves.toBeUndefined();

    expect(cf).toHaveBeenCalledExactlyOnceWith(listPath);
  });

  it("fails closed without mutating an existing binding", async () => {
    const cf = vi.fn(async () => [{ name: secretName, type: "secret_text" }]);

    await expect(assertWorkerSecretAbsent({ cf, workerName, secretName })).rejects.toThrow(
      /Forbidden Worker secret is present/,
    );
    expect(cf).toHaveBeenCalledExactlyOnceWith(listPath);
  });

  it("fails closed when Cloudflare returns an unexpected secret-list shape", async () => {
    const cf = vi.fn(async () => ({ secrets: [] }));

    await expect(assertWorkerSecretAbsent({ cf, workerName, secretName })).rejects.toThrow();
  });

  it("propagates Cloudflare failures other than a missing Worker", async () => {
    const cloudflareError = new CloudflareApiError("GET", listPath, 503, [{ code: 10000 }]);
    const cf = vi.fn(async () => {
      throw cloudflareError;
    });

    await expect(assertWorkerSecretAbsent({ cf, workerName, secretName })).rejects.toBe(
      cloudflareError,
    );
  });
});

describe("removeWorkerSecrets", () => {
  const retiredSecretNames = [secretName, "APP_CONFIG_SLACK_BOT_TOKEN"] as const;

  it("deletes only named retired secrets and verifies the resulting binding set", async () => {
    const allowedSecret = "APP_CONFIG_OPEN_AI_API_KEY";
    const cf = vi
      .fn()
      .mockResolvedValueOnce([
        { name: allowedSecret, type: "secret_text" },
        { name: retiredSecretNames[1], type: "secret_text" },
        { name: secretName, type: "secret_text" },
      ])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ name: allowedSecret, type: "secret_text" }]);

    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: retiredSecretNames }),
    ).resolves.toEqual([...retiredSecretNames].sort());

    expect(cf.mock.calls).toEqual([
      [listPath],
      [`${listPath}/${secretName}`, { method: "DELETE" }],
      [`${listPath}/${retiredSecretNames[1]}`, { method: "DELETE" }],
      [listPath],
    ]);
  });

  it("is an idempotent no-op when the Worker has no retired secrets", async () => {
    const cf = vi.fn(async () => [{ name: "CURRENT_SECRET", type: "secret_text" }]);

    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: retiredSecretNames }),
    ).resolves.toEqual([]);

    expect(cf).toHaveBeenCalledExactlyOnceWith(listPath);
  });

  it("is an idempotent no-op when the Worker has not been created", async () => {
    const cf = vi.fn(async () => {
      throw new CloudflareApiError("GET", listPath, 404, [{ code: 10007 }]);
    });

    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: retiredSecretNames }),
    ).resolves.toEqual([]);

    expect(cf).toHaveBeenCalledExactlyOnceWith(listPath);
  });

  it("fails closed when deletion does not remove a retired secret", async () => {
    const binding = { name: secretName, type: "secret_text" };
    const cf = vi
      .fn()
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([binding]);

    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: retiredSecretNames }),
    ).rejects.toThrow(`Retired Worker secrets remain after deletion: ${workerName}/${secretName}`);
  });
});

describe("smokeResponse", () => {
  it("can require an exact response body rather than trusting the status alone", async () => {
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
});

describe("R2 object-expiry lifecycle", () => {
  it("builds one Age rule scoped to every object by default (empty prefix)", () => {
    const rules = buildR2ObjectExpiryLifecycleRules({ ruleId: "r", ttlSeconds: 3600 });

    expect(rules).toEqual([
      {
        id: "r",
        enabled: true,
        // Empty prefix = all objects; deleting after an Age in seconds.
        conditions: { prefix: "" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 3600 } },
      },
    ]);
  });

  it("scopes the shared sandbox rule to backups/ (prd 90d ttl here)", () => {
    // Same rule id + prefix as ensure-resources and erase-data both install
    // (they differ only in ttl: 3h preview, 90d prd).
    expect(SANDBOX_BACKUP_EXPIRY_RULE).toEqual({
      ruleId: "expire-sandbox-workspace-backups",
      prefix: "backups/",
    });
    const rules = buildR2ObjectExpiryLifecycleRules({
      ...SANDBOX_BACKUP_EXPIRY_RULE,
      ttlSeconds: SANDBOX_BACKUP_TTL_SECONDS_PRD,
    });

    expect(rules[0]?.conditions).toEqual({ prefix: "backups/" });
    expect(rules[0]?.deleteObjectsTransition.condition).toEqual({
      type: "Age",
      maxAge: 90 * 24 * 60 * 60,
    });
  });

  it("expires all preview disposable data 3h after write", () => {
    // Guards against an accidental bump: erase-data relies on prompt expiry so
    // it can skip per-object preview deletes.
    expect(PREVIEW_DISPOSABLE_TTL_SECONDS).toBe(3 * 60 * 60);
    expect(PREVIEW_FILES_OBJECT_EXPIRY.ttlSeconds).toBe(PREVIEW_DISPOSABLE_TTL_SECONDS);
    expect(PREVIEW_FILES_OBJECT_EXPIRY.ruleId).toBe("expire-preview-files");
  });

  it("PUTs the rule to the bucket's lifecycle endpoint", async () => {
    const cf = vi.fn(async () => ({}));

    await ensureR2ObjectExpiryLifecycle(
      { cf, cfV4: vi.fn() } as never,
      "os-preview-7-files",
      PREVIEW_FILES_OBJECT_EXPIRY,
    );

    expect(cf).toHaveBeenCalledOnce();
    const [path, init] = cf.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/r2/buckets/os-preview-7-files/lifecycle");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      rules: buildR2ObjectExpiryLifecycleRules(PREVIEW_FILES_OBJECT_EXPIRY),
    });
  });
});
