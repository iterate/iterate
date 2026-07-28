import { describe, expect, test } from "vitest";
import { parseConfig } from "../../config.ts";
import {
  primeProjectHostname,
  readProjectByHostname,
  readProjectHostnameRegistration,
} from "../../project-hostname-directory.ts";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import {
  createCloudflareCustomDomainProvisioner,
  normalizeProjectCustomDomain,
  primeDirectProjectCustomDomain,
} from "./custom-domains.ts";

const project: ProjectDirectoryRecord = {
  id: "prj_garple",
  name: "Garple",
  organizationId: "org_1",
  slug: "garple",
};

const otherProject: ProjectDirectoryRecord = {
  id: "prj_other",
  name: "Other",
  organizationId: "org_1",
  slug: "other",
};

describe("custom domain provisioning", () => {
  test("normalizes hostnames and primes direct Worker routes in KV", async () => {
    const { directory } = setup();
    expect(
      normalizeProjectCustomDomain({
        hostname: " Garple.Com:443. ",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toBe("garple.com");
    expect(() =>
      normalizeProjectCustomDomain({
        hostname: "garple.iterate.app",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toThrow(/reserved/);

    await expect(
      primeDirectProjectCustomDomain({
        directory,
        hostname: " Iterate.COM. ",
        project,
        projectHostnameBases: ["iterate.app"],
      }),
    ).resolves.toBe("iterate.com");
    await expect(readProjectHostnameRegistration(directory, "iterate.com")).resolves.toEqual(
      project,
    );
  });

  test("creates a metadata-free Cloudflare hostname after claiming its KV route", async () => {
    const { cloudflare, directory, provisioner } = setup();

    await expect(provisioner.ensure({ hostname: "garple.com", project })).resolves.toBeUndefined();

    expect(cloudflare.createdBodies).toEqual([
      {
        hostname: "garple.com",
        ssl: {
          method: "txt",
          settings: { min_tls_version: "1.2" },
          type: "dv",
          wildcard: true,
        },
      },
    ]);
    expect(cloudflare.requests.filter((request) => request.method === "GET")).toHaveLength(2);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toEqual({
      appSlug: "counter",
      record: project,
    });
  });

  test("reuses an existing Cloudflare hostname to heal wiped routing KV", async () => {
    const { cloudflare, directory, provisioner } = setup({
      hostnames: [{ hostname: "garple.com", id: "custom-hostname-1" }],
    });

    await provisioner.ensure({ hostname: "garple.com", project });

    expect(cloudflare.createdBodies).toEqual([]);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
  });

  test("rejects a hostname that overlaps another project's KV route before Cloudflare", async () => {
    const { cloudflare, directory, provisioner } = setup();
    await primeProjectHostname(directory, "www.garple.com", otherProject);

    await expect(provisioner.ensure({ hostname: "garple.com", project })).rejects.toThrow(
      /overlaps existing custom domain "www\.garple\.com"/,
    );
    expect(cloudflare.requests).toEqual([]);
  });

  test("deletes the hostname found by name and then clears its KV route", async () => {
    const { cloudflare, directory, provisioner } = setup({
      hostnames: [{ hostname: "garple.com", id: "custom-hostname-1" }],
    });
    await primeProjectHostname(directory, "garple.com", project);

    await provisioner.remove({ hostname: "garple.com", project });

    expect(cloudflare.deletedIds).toEqual(["custom-hostname-1"]);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });
});

function setup(input: { hostnames?: CloudflareHostname[] } = {}) {
  const directory = new MemoryKv() as unknown as KVNamespace;
  const cloudflare = createCloudflareFetchMock(input.hostnames ?? []);
  const provisioner = createCloudflareCustomDomainProvisioner({
    config: parseConfig({
      APP_CONFIG: JSON.stringify({
        cloudflare: { accountId: "account-1", apiToken: "cf-token" },
        openAiApiKey: "openai-key",
        projectHostnameBases: ["iterate.app"],
      }),
    }),
    directory,
    fetch: cloudflare.fetch,
  });
  return { cloudflare, directory, provisioner };
}

class MemoryKv {
  readonly values = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? (JSON.parse(value) as T) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: { cursor?: string; prefix?: string } = {}) {
    const prefix = options.prefix ?? "";
    return {
      cursor: "",
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

type CloudflareHostname = { hostname: string; id: string };

function createCloudflareFetchMock(initialHostnames: CloudflareHostname[]) {
  const hostnames = new Map(
    initialHostnames.map((hostname) => [hostname.hostname, hostname] as const),
  );
  const createdBodies: unknown[] = [];
  const deletedIds: string[] = [];
  const requests: Array<{ method: string; pathname: string }> = [];

  const fetchMock = (async (...args: Parameters<typeof fetch>) => {
    const [requestInput, init] = args;
    const request =
      requestInput instanceof Request ? requestInput : new Request(requestInput, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, pathname: url.pathname });

    if (url.pathname === "/client/v4/zones") {
      return Response.json({
        success: true,
        result: [{ id: "zone-1", name: "iterate.app" }],
      });
    }

    if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames") {
      if (request.method === "GET") {
        const exact = url.searchParams.get("hostname.exact");
        return Response.json({
          success: true,
          result: [...hostnames.values()].filter(
            (candidate) => exact === null || candidate.hostname === exact,
          ),
        });
      }
      const body = (await request.json()) as Record<string, unknown>;
      createdBodies.push(body);
      const hostname = String(body.hostname);
      const customHostname = { hostname, id: "custom-hostname-1" };
      hostnames.set(hostname, customHostname);
      return Response.json({ success: true, result: customHostname });
    }

    const hostnameId = url.pathname.match(
      /^\/client\/v4\/zones\/zone-1\/custom_hostnames\/(.+)$/,
    )?.[1];
    if (hostnameId && request.method === "DELETE") {
      const id = decodeURIComponent(hostnameId);
      deletedIds.push(id);
      const customHostname = [...hostnames.values()].find((candidate) => candidate.id === id);
      if (customHostname) hostnames.delete(customHostname.hostname);
      return Response.json({ success: true, result: {} });
    }

    return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
  }) as typeof fetch;

  return { createdBodies, deletedIds, fetch: fetchMock, requests };
}
