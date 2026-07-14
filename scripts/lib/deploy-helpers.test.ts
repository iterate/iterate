import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWorkerSecretAbsent, smokeResponse } from "./deploy-helpers.ts";
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
