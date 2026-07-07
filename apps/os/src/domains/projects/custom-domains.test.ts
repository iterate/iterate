import { describe, expect, it } from "vitest";
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
} from "./custom-domains.ts";

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

function createProvisioner(input: { directory: KVNamespace; fetch: typeof fetch }) {
  return createCloudflareCustomDomainProvisioner({
    config: parseConfig({
      APP_CONFIG: JSON.stringify({
        cloudflare: {
          accountId: "account-1",
          apiToken: "cf-token",
        },
        openAiApiKey: "openai-key",
        projectHostnameBases: ["iterate.app"],
      }),
    }),
    directory: input.directory,
    fetch: input.fetch,
  });
}

type CloudflareHostnameFixture = Record<string, unknown> & {
  custom_metadata?: Record<string, unknown> | null;
  hostname: string;
  id: string;
  ssl?: Record<string, unknown> | null;
  status?: string;
};

function cloudflareHostname(
  input: {
    hostname?: string;
    id?: string;
    project?: ProjectDirectoryRecord;
    status?: "active" | "pending";
  } = {},
): CloudflareHostnameFixture {
  const hostname = input.hostname ?? "garple.com";
  const owner = input.project ?? project;
  const status = input.status ?? "active";
  return {
    custom_metadata: {
      projectId: owner.id,
      projectSlug: owner.slug,
      source: "iterate-os",
    },
    hostname,
    id: input.id ?? "custom-hostname-1",
    ownership_verification: {
      name: `_cf-custom-hostname.${hostname}`,
      value: "ownership-token",
    },
    ssl: {
      status: status === "active" ? "active" : "pending_validation",
      validation_records:
        status === "active"
          ? []
          : [
              {
                status: "pending",
                txt_name: `_acme-challenge.${hostname}`,
                txt_value: "ssl-token",
              },
            ],
      wildcard: true,
    },
    status,
  };
}

function createCloudflareFetchMock(
  input: {
    createHostname?: (body: Record<string, unknown>) => CloudflareHostnameFixture;
    hostnames?: CloudflareHostnameFixture[];
  } = {},
) {
  const hostnames = new Map(
    (input.hostnames ?? []).map((hostname) => [hostname.hostname, hostname] as const),
  );
  const createdBodies: unknown[] = [];
  const deletedIds: string[] = [];

  const fetchMock = (async (...args: Parameters<typeof fetch>) => {
    const [requestInput, init] = args;
    const request =
      requestInput instanceof Request ? requestInput : new Request(requestInput, init);
    const url = new URL(request.url);

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
      const customHostname =
        input.createHostname?.(body) ??
        cloudflareHostname({
          hostname,
          status: "pending",
        });
      hostnames.set(customHostname.hostname, customHostname);
      return Response.json({ success: true, result: customHostname });
    }

    const hostnameId = url.pathname.match(
      /^\/client\/v4\/zones\/zone-1\/custom_hostnames\/(.+)$/,
    )?.[1];
    if (hostnameId) {
      const id = decodeURIComponent(hostnameId);
      const customHostname = [...hostnames.values()].find((candidate) => candidate.id === id);

      if (request.method === "GET") {
        return customHostname
          ? Response.json({ success: true, result: customHostname })
          : cloudflareNotFound();
      }

      if (request.method === "DELETE") {
        deletedIds.push(id);
        if (!customHostname) return cloudflareNotFound();
        hostnames.delete(customHostname.hostname);
        return Response.json({ success: true, result: {} });
      }
    }

    return cloudflareNotFound();
  }) as typeof fetch;

  return { createdBodies, deletedIds, fetch: fetchMock, hostnames };
}

function cloudflareNotFound() {
  return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
}

describe("custom domain provisioning", () => {
  it("normalizes custom domains and rejects reserved project hostnames", () => {
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
  });

  it("creates a wildcard Cloudflare custom hostname without routing before validation is active", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const cloudflare = createCloudflareFetchMock();
    const provisioner = createProvisioner({ directory, fetch: cloudflare.fetch });

    const snapshot = await provisioner.ensure({ hostname: "garple.com", project });

    expect(cloudflare.createdBodies).toEqual([
      {
        custom_metadata: {
          projectId: "prj_garple",
          projectSlug: "garple",
          source: "iterate-os",
        },
        hostname: "garple.com",
        ssl: {
          method: "txt",
          settings: { min_tls_version: "1.2" },
          type: "dv",
          wildcard: true,
        },
      },
    ]);
    expect(snapshot).toMatchObject({
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      status: "pending_validation",
      validationRecords: [
        {
          name: "_acme-challenge.garple.com",
          status: "pending",
          value: "ssl-token",
        },
      ],
      wildcard: true,
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toBeNull();
  });

  it("rejects apex domains that would cover another project's explicit subdomain", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    await primeProjectHostname(directory, "www.garple.com", otherProject);
    let fetchCalls = 0;
    const provisioner = createProvisioner({
      directory,
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error("Cloudflare should not be called for unavailable hostnames.");
      }) as typeof fetch,
    });

    await expect(provisioner.ensure({ hostname: "garple.com", project })).rejects.toThrow(
      /overlaps existing custom domain "www\.garple\.com"/,
    );
    expect(fetchCalls).toBe(0);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("refreshes an existing Cloudflare hostname and heals missing routing KV", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const cloudflare = createCloudflareFetchMock({
      hostnames: [cloudflareHostname()],
    });
    const provisioner = createProvisioner({ directory, fetch: cloudflare.fetch });

    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();

    const snapshot = await provisioner.refresh({ hostname: "garple.com", project });

    expect(snapshot.status).toBe("active");
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toEqual({
      appSlug: "counter",
      record: project,
    });
  });

  it("removes same-project routing KV when a refreshed hostname is no longer active", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const cloudflare = createCloudflareFetchMock({
      hostnames: [cloudflareHostname()],
    });
    const provisioner = createProvisioner({ directory, fetch: cloudflare.fetch });

    await expect(provisioner.refresh({ hostname: "garple.com", project })).resolves.toMatchObject({
      status: "active",
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );

    cloudflare.hostnames.set("garple.com", cloudflareHostname({ status: "pending" }));
    await expect(provisioner.refresh({ hostname: "garple.com", project })).resolves.toMatchObject({
      status: "pending_validation",
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("refuses to adopt or remove a Cloudflare hostname owned by another project", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const cloudflare = createCloudflareFetchMock({
      hostnames: [cloudflareHostname({ project: otherProject })],
    });
    const provisioner = createProvisioner({ directory, fetch: cloudflare.fetch });

    await expect(provisioner.ensure({ hostname: "garple.com", project })).rejects.toThrow(
      /owned by another project/,
    );
    await primeProjectHostname(directory, "garple.com", otherProject);
    await expect(
      provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
    ).rejects.toThrow(/owned by another project/);
    expect(cloudflare.deletedIds).toEqual([]);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      otherProject,
    );
  });

  it("treats stale Cloudflare delete ids as already removed and clears same-project routing", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    await primeProjectHostname(directory, "garple.com", project);
    const cloudflare = createCloudflareFetchMock();
    const provisioner = createProvisioner({ directory, fetch: cloudflare.fetch });

    await expect(
      provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
    ).resolves.toBeUndefined();
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });
});
