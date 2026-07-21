import { describe, expect, test, vi } from "vitest";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  cloudflareWorkerVersionOverrideHeaders,
  createCloudflareWorkerVersionOverrideFetch,
  E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV,
  mergeCloudflareWorkerVersionOverrideHeaders,
  renderCloudflareWorkerVersionOverrides,
} from "./cloudflare-worker-version-overrides.ts";

const osVersion = "11111111-1111-4111-8111-111111111111";
const authVersion = "22222222-2222-4222-8222-222222222222";

describe("Cloudflare Worker version overrides", () => {
  test("renders a deterministic exact-version dictionary", () => {
    expect(
      renderCloudflareWorkerVersionOverrides([
        { versionId: osVersion, workerName: "os-preview-7" },
        { versionId: authVersion, workerName: "auth-preview-7" },
      ]),
    ).toBe(`auth-preview-7="${authVersion}",os-preview-7="${osVersion}"`);
  });

  test("rejects duplicate or malformed deployment identities", () => {
    expect(() =>
      renderCloudflareWorkerVersionOverrides([
        { versionId: osVersion, workerName: "os-preview-7" },
        { versionId: authVersion, workerName: "os-preview-7" },
      ]),
    ).toThrow(/more than one version override/);
    expect(() =>
      renderCloudflareWorkerVersionOverrides([{ versionId: "latest", workerName: "OS preview 7" }]),
    ).toThrow(/not a valid Structured Fields dictionary key/);
  });

  test("is absent locally and preserves existing request headers in preview", () => {
    expect(cloudflareWorkerVersionOverrideHeaders({})).toEqual({});

    const value = `os-preview-7="${osVersion}"`;
    const environment = { [E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV]: value };
    expect(cloudflareWorkerVersionOverrideHeaders(environment)).toEqual({
      [CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER]: value,
    });

    const merged = mergeCloudflareWorkerVersionOverrideHeaders(
      { authorization: "Bearer test" },
      environment,
    );
    expect(merged.get("authorization")).toBe("Bearer test");
    expect(merged.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER)).toBe(value);
  });

  test("wraps fetch without dropping Request or init headers", async () => {
    const value = `os-preview-7="${osVersion}"`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const overrideFetch = createCloudflareWorkerVersionOverrideFetch(fetchMock, {
      [E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV]: value,
    });

    await overrideFetch(new Request("https://os.example/api", { headers: { cookie: "a=b" } }), {
      headers: { authorization: "Bearer test" },
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cookie")).toBe("a=b");
    expect(headers.get("authorization")).toBe("Bearer test");
    expect(headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER)).toBe(value);
  });

  test("rejects a malformed non-empty environment value", () => {
    expect(() =>
      cloudflareWorkerVersionOverrideHeaders({
        [E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV]: "os-preview-7=latest",
      }),
    ).toThrow(/is not an exact Worker version override dictionary/);
  });
});
