import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerSecretAbsent,
  buildR2ObjectExpiryLifecycleRules,
  ensureR2ObjectExpiryLifecycle,
  PREVIEW_DISPOSABLE_TTL_SECONDS,
  PREVIEW_FILES_OBJECT_EXPIRY,
  PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY,
  SANDBOX_BACKUP_EXPIRY_RULE,
  SANDBOX_BACKUP_TTL_SECONDS_PRD,
  smokeResponse,
} from "./deploy-helpers.ts";
import { CloudflareApiError } from "./env-context.ts";

afterEach(() => vi.unstubAllGlobals());

const workerName = "os-prd";
const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const listPath = `/workers/scripts/${workerName}/secrets`;

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
    // Guards against an accidental bump: erase-data relies on this expiring the
    // corpus/files promptly so it can skip the per-object delete on previews,
    // and the whole point is cost — abandoned data must not linger a full day.
    expect(PREVIEW_DISPOSABLE_TTL_SECONDS).toBe(3 * 60 * 60);
    expect(PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY.ttlSeconds).toBe(PREVIEW_DISPOSABLE_TTL_SECONDS);
    expect(PREVIEW_FILES_OBJECT_EXPIRY.ttlSeconds).toBe(PREVIEW_DISPOSABLE_TTL_SECONDS);
    expect(PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY.ruleId).toBe("expire-preview-search-index");
    expect(PREVIEW_FILES_OBJECT_EXPIRY.ruleId).toBe("expire-preview-files");
  });

  it("PUTs the rule to the bucket's lifecycle endpoint", async () => {
    const cf = vi.fn(async () => ({}));

    await ensureR2ObjectExpiryLifecycle(
      { cf, cfV4: vi.fn() } as never,
      "os-preview-7-search-index",
      PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY,
    );

    expect(cf).toHaveBeenCalledOnce();
    const [path, init] = cf.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/r2/buckets/os-preview-7-search-index/lifecycle");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      rules: buildR2ObjectExpiryLifecycleRules(PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY),
    });
  });
});
