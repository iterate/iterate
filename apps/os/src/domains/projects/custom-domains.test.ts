import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.ts";
import {
  readProjectByHostname,
  readProjectHostnameRegistration,
  type ProjectDirectoryRecord,
} from "../../project-directory.ts";
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

  it("creates a wildcard Cloudflare custom hostname and writes routing KV", async () => {
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
            hostname: "garple.com",
            id: "custom-hostname-1",
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
          };
          return Response.json({ success: true, result: customHostname });
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
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      status: "pending_validation",
      wildcard: true,
    });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    await expect(readProjectByHostname(directory, "garple.com")).resolves.toEqual({
      appSlug: null,
      record: project,
    });
    await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toEqual({
      appSlug: "counter",
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

    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();

    const snapshot = await provisioner.refresh({ hostname: "garple.com", project });

    expect(snapshot.status).toBe("active");
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
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
      ),
    ).toMatchObject({
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      sslStatus: "active",
      status: "active",
      wildcard: true,
    });
  });
});
