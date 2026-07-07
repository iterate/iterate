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
  toProjectCustomDomainCloudflareSnapshot,
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
    const createdBodies: unknown[] = [];
    let customHostname: Record<string, unknown> | null = null;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames") {
          if (request.method === "GET") {
            return Response.json({
              success: true,
              result: customHostname ? [customHostname] : [],
            });
          }

          createdBodies.push(await request.json());
          customHostname = {
            custom_metadata: {
              projectId: "prj_garple",
              projectSlug: "garple",
              source: "iterate-os",
            },
            hostname: "garple.com",
            id: "custom-hostname-1",
            ssl: {
              status: "pending_validation",
              wildcard: true,
            },
            status: "pending",
          };
          return Response.json({ success: true, result: customHostname });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames/custom-hostname-1") {
          return Response.json({
            success: true,
            result: {
              ...customHostname,
              hostname: "garple.com",
              id: "custom-hostname-1",
              custom_metadata: {
                projectId: "prj_garple",
                projectSlug: "garple",
                source: "iterate-os",
              },
              ownership_verification: {
                name: "_cf-custom-hostname.garple.com",
                value: "ownership-token",
              },
              ssl: {
                status: "pending_validation",
                validation_records: [
                  {
                    status: "pending",
                    txt_name: "_acme-challenge.garple.com",
                    txt_value: "ssl-token",
                  },
                ],
                wildcard: true,
              },
              status: "pending",
            },
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/dcv_delegation/uuid") {
          return Response.json({
            success: true,
            result: { uuid: "248299803bb79c97" },
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    const snapshot = await provisioner.ensure({ hostname: "garple.com", project });

    expect(createdBodies).toEqual([
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
      certificateDelegationCname: {
        name: "_acme-challenge.garple.com",
        value: "garple.com.248299803bb79c97.dcv.cloudflare.com",
      },
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
    await expect(readProjectByHostname(directory, "garple.com")).resolves.toBeNull();
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toBeNull();
  });

  it("registers explicit subdomain custom domains over parent app routing", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    await primeProjectHostname(directory, "garple.com", project);
    const createdBodies: unknown[] = [];
    let customHostname: Record<string, unknown> | null = null;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames") {
          if (request.method === "GET") {
            return Response.json({
              success: true,
              result: customHostname ? [customHostname] : [],
            });
          }

          createdBodies.push(await request.json());
          customHostname = {
            custom_metadata: {
              projectId: "prj_garple",
              projectSlug: "garple",
              source: "iterate-os",
            },
            hostname: "www.garple.com",
            id: "custom-hostname-www",
            ssl: { status: "active", wildcard: true },
            status: "active",
          };
          return Response.json({ success: true, result: customHostname });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames/custom-hostname-www") {
          return Response.json({
            success: true,
            result: customHostname,
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/dcv_delegation/uuid") {
          return Response.json({
            success: true,
            result: { uuid: "248299803bb79c97" },
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    const snapshot = await provisioner.ensure({ hostname: "www.garple.com", project });

    expect(createdBodies).toMatchObject([{ hostname: "www.garple.com" }]);
    expect(snapshot).toMatchObject({
      hostname: "www.garple.com",
      status: "active",
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectHostnameRegistration(directory, "www.garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectByHostname(directory, "www.garple.com")).resolves.toEqual({
      appSlug: null,
      record: project,
    });
  });

  it("rejects apex domains that would cover another project's explicit subdomain", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const otherProject: ProjectDirectoryRecord = {
      id: "prj_other",
      name: "Other",
      organizationId: "org_1",
      slug: "other",
    };
    await primeProjectHostname(directory, "www.garple.com", otherProject);
    let fetchCalls = 0;
    const provisioner = createCloudflareCustomDomainProvisioner({
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

  it("registers active custom subdomains when no parent domain route exists", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({
            success: true,
            result: [
              {
                custom_metadata: {
                  projectId: "prj_garple",
                  projectSlug: "garple",
                  source: "iterate-os",
                },
                hostname: "www.garple.com",
                id: "custom-hostname-www",
                ssl: { status: "active", wildcard: true },
                status: "active",
              },
            ],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/dcv_delegation/uuid") {
          return Response.json({
            success: true,
            result: { uuid: "248299803bb79c97" },
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(
      provisioner.refresh({ hostname: "www.garple.com", project }),
    ).resolves.toMatchObject({
      hostname: "www.garple.com",
      status: "active",
    });
    await expect(readProjectHostnameRegistration(directory, "www.garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectByHostname(directory, "www.garple.com")).resolves.toEqual({
      appSlug: null,
      record: project,
    });
  });

  it("refreshes an existing Cloudflare hostname and heals missing routing KV", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({
            success: true,
            result: [
              {
                custom_metadata: {
                  projectId: "prj_garple",
                  projectSlug: "garple",
                  source: "iterate-os",
                },
                hostname: "garple.com",
                id: "custom-hostname-1",
                ssl: { status: "active", wildcard: true },
                status: "active",
              },
            ],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/dcv_delegation/uuid") {
          return Response.json({
            success: true,
            result: { uuid: "248299803bb79c97" },
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();

    const snapshot = await provisioner.refresh({ hostname: "garple.com", project });

    expect(snapshot.certificateDelegationCname).toEqual({
      name: "_acme-challenge.garple.com",
      value: "garple.com.248299803bb79c97.dcv.cloudflare.com",
    });
    expect(snapshot.status).toBe("active");
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    await expect(
      readProjectHostnameRegistration(directory, "counter.garple.com"),
    ).resolves.toBeNull();
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toEqual({
      appSlug: "counter",
      record: project,
    });
  });

  it("removes same-project routing KV when a refreshed hostname is no longer active", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    let cloudflareStatus: "active" | "pending" = "active";
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({
            success: true,
            result: [
              {
                custom_metadata: {
                  projectId: "prj_garple",
                  projectSlug: "garple",
                  source: "iterate-os",
                },
                hostname: "garple.com",
                id: "custom-hostname-1",
                ssl: {
                  status: cloudflareStatus === "active" ? "active" : "pending_validation",
                  wildcard: true,
                },
                status: cloudflareStatus,
              },
            ],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/dcv_delegation/uuid") {
          return Response.json({
            success: true,
            result: { uuid: "248299803bb79c97" },
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(provisioner.refresh({ hostname: "garple.com", project })).resolves.toMatchObject({
      status: "active",
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );

    cloudflareStatus = "pending";
    await expect(provisioner.refresh({ hostname: "garple.com", project })).resolves.toMatchObject({
      status: "pending_validation",
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("refuses to adopt a Cloudflare hostname owned by another project", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({
            success: true,
            result: [
              {
                custom_metadata: {
                  projectId: "prj_other",
                  projectSlug: "other",
                  source: "iterate-os",
                },
                hostname: "garple.com",
                id: "custom-hostname-1",
                ssl: { status: "active", wildcard: true },
                status: "active",
              },
            ],
          });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(provisioner.ensure({ hostname: "garple.com", project })).rejects.toThrow(
      /owned by another project/,
    );
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("leaves a Cloudflare hostname and routing owned by another project when removing", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    const otherProject: ProjectDirectoryRecord = {
      id: "prj_other",
      name: "Other",
      organizationId: "org_1",
      slug: "other",
    };
    await primeProjectHostname(directory, "garple.com", otherProject);
    let deleteCount = 0;
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames") {
          if (request.method === "GET") {
            return Response.json({
              success: true,
              result: [
                {
                  custom_metadata: {
                    projectId: "prj_other",
                    projectSlug: "other",
                    source: "iterate-os",
                  },
                  hostname: "garple.com",
                  id: "custom-hostname-1",
                  ssl: { status: "active", wildcard: true },
                  status: "active",
                },
              ],
            });
          }
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames/custom-hostname-1") {
          deleteCount += 1;
          return Response.json({ success: true, result: {} });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(
      provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
    ).resolves.toBeUndefined();
    expect(deleteCount).toBe(0);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      otherProject,
    );
  });

  it("treats stale Cloudflare delete ids as already removed and clears same-project routing", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    await primeProjectHostname(directory, "garple.com", project);
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({ success: true, result: [] });
        }

        if (url.pathname === "/client/v4/zones/zone-1/custom_hostnames/stale-id") {
          return Response.json(
            { success: false, errors: [{ message: "not found" }] },
            { status: 404 },
          );
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(
      provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
    ).resolves.toBeUndefined();
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("uses a live Cloudflare hostname id instead of stale project state when removing", async () => {
    const directory = new MemoryKv() as unknown as KVNamespace;
    await primeProjectHostname(directory, "garple.com", project);
    const deletedIds: string[] = [];
    const provisioner = createCloudflareCustomDomainProvisioner({
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
      directory,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname === "/client/v4/zones") {
          return Response.json({
            success: true,
            result: [{ id: "zone-1", name: "iterate.app" }],
          });
        }

        if (
          url.pathname === "/client/v4/zones/zone-1/custom_hostnames" &&
          request.method === "GET"
        ) {
          return Response.json({
            success: true,
            result: [
              {
                custom_metadata: {
                  projectId: "prj_garple",
                  projectSlug: "garple",
                  source: "iterate-os",
                },
                hostname: "garple.com",
                id: "fresh-id",
                ssl: { status: "active", wildcard: true },
                status: "active",
              },
            ],
          });
        }

        if (
          url.pathname.startsWith("/client/v4/zones/zone-1/custom_hostnames/") &&
          request.method === "DELETE"
        ) {
          deletedIds.push(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
          return Response.json({ success: true, result: {} });
        }

        return Response.json(
          { success: false, errors: [{ message: "not found" }] },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    await expect(
      provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
    ).resolves.toBeUndefined();

    expect(deletedIds).toEqual(["fresh-id"]);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  it("maps active Cloudflare hostname and SSL status to an active project domain", () => {
    expect(
      toProjectCustomDomainCloudflareSnapshot(
        {
          hostname: "garple.com",
          id: "custom-hostname-1",
          ssl: { status: "active", wildcard: true },
          status: "active",
        },
        "garple.com",
        { dcvDelegationUuid: "248299803bb79c97" },
      ),
    ).toMatchObject({
      certificateDelegationCname: {
        name: "_acme-challenge.garple.com",
        value: "garple.com.248299803bb79c97.dcv.cloudflare.com",
      },
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      sslStatus: "active",
      status: "active",
      wildcard: true,
    });
  });

  it("keeps TXT validation fallback when delegated DCV is unavailable", () => {
    expect(
      toProjectCustomDomainCloudflareSnapshot(
        {
          hostname: "garple.com",
          id: "custom-hostname-1",
          ssl: {
            status: "pending_validation",
            validation_records: [
              {
                status: "pending",
                txt_name: "_acme-challenge.garple.com",
                txt_value: "ssl-token",
              },
            ],
            wildcard: true,
          },
          status: "pending",
        },
        "garple.com",
      ),
    ).toMatchObject({
      certificateDelegationCname: null,
      hostname: "garple.com",
      status: "pending_validation",
      validationRecords: [
        {
          name: "_acme-challenge.garple.com",
          status: "pending",
          value: "ssl-token",
        },
      ],
    });
  });
});
