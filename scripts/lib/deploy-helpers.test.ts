import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteWorkerSecretIfPresent, smokeResponse } from "./deploy-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

const workerName = "os-prd";
const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const listPath = `/workers/scripts/${workerName}/secrets`;
const deletePath = `${listPath}/${secretName}?url_encoded=true`;

describe("deleteWorkerSecretIfPresent", () => {
  it("does nothing when the retired binding is already absent", async () => {
    const cf = vi.fn(async () => []);

    await expect(deleteWorkerSecretIfPresent({ cf, workerName, secretName })).resolves.toBe(false);

    expect(cf).toHaveBeenCalledOnce();
    expect(cf).toHaveBeenCalledWith(listPath);
  });

  it("deletes an existing binding and verifies its removal", async () => {
    let listCount = 0;
    const cf = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === listPath && !init) {
        listCount += 1;
        return listCount === 1 ? [{ name: secretName, type: "secret_text" }] : [];
      }
      if (path === deletePath && init?.method === "DELETE") return undefined;
      throw new Error(`unexpected Cloudflare request: ${init?.method ?? "GET"} ${path}`);
    });

    await expect(deleteWorkerSecretIfPresent({ cf, workerName, secretName })).resolves.toBe(true);

    expect(cf.mock.calls).toEqual([[listPath], [deletePath, { method: "DELETE" }], [listPath]]);
  });

  it("fails closed when Cloudflare still reports the binding", async () => {
    const cf = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === listPath) return [{ name: secretName, type: "secret_text" }];
      if (path === deletePath && init?.method === "DELETE") return undefined;
      throw new Error(`unexpected Cloudflare request: ${init?.method ?? "GET"} ${path}`);
    });

    await expect(deleteWorkerSecretIfPresent({ cf, workerName, secretName })).rejects.toThrow(
      /retired Worker secret remains/,
    );
  });

  it("fails closed when Cloudflare returns an unexpected secret-list shape", async () => {
    const cf = vi.fn(async () => ({ secrets: [] }));

    await expect(deleteWorkerSecretIfPresent({ cf, workerName, secretName })).rejects.toThrow();
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
