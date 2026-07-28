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
  test("normalizes custom domains and rejects reserved project hostnames", () => {
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

  test("primes a direct platform-owned hostname without Cloudflare provisioning", async () => {
    const { directory } = setup();
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

  test("creates a wildcard Cloudflare custom hostname without routing before validation is active", async () => {
    const { cloudflare, directory, provisioner } = setup();

    const snapshot = await provisioner.ensure({ hostname: "garple.com", project });

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

  test("calls Cloudflare fetch without binding the client input as this", async () => {
    const cloudflare = createCloudflareFetchMock();
    let fetchCalls = 0;
    const fetchWithThisAssertion = async function (
      this: unknown,
      ...args: Parameters<typeof fetch>
    ) {
      fetchCalls += 1;
      expect(this).toBeUndefined();
      return await cloudflare.fetch(...args);
    } as typeof fetch;
    const { provisioner } = setup({ fetch: fetchWithThisAssertion });

    await expect(provisioner.ensure({ hostname: "garple.com", project })).resolves.toMatchObject({
      hostname: "garple.com",
    });
    expect(fetchCalls).toBeGreaterThan(0);
  });

  test("rejects apex domains that would cover another project's explicit subdomain", async () => {
    let fetchCalls = 0;
    const { directory, provisioner } = setup({
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error("Cloudflare should not be called for unavailable hostnames.");
      }) as typeof fetch,
    });
    await primeProjectHostname(directory, "www.garple.com", otherProject);

    await expect(provisioner.ensure({ hostname: "garple.com", project })).rejects.toThrow(
      /overlaps existing custom domain "www\.garple\.com"/,
    );
    expect(fetchCalls).toBe(0);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();
  });

  test.for([
    {
      name: "refreshes an existing Cloudflare hostname and heals missing routing KV",
      hostnames: [cloudflareHostname()],
      expectedSnapshot: { status: "active" },
      expectedAppHost: { appSlug: "counter", record: project },
    },
    {
      name: "refreshes a recorded Cloudflare hostname id",
      hostnames: [cloudflareHostname({ id: "custom-hostname-1" })],
      refreshInput: { cloudflareHostnameId: "custom-hostname-1" },
      expectedSnapshot: { status: "active" },
    },
    {
      name: "falls back to hostname lookup when the recorded Cloudflare hostname id is stale",
      hostnames: [cloudflareHostname({ id: "custom-hostname-2" })],
      refreshInput: { cloudflareHostnameId: "stale-custom-hostname-id" },
      expectedSnapshot: {
        cloudflareHostnameId: "custom-hostname-2",
        hostname: "garple.com",
        status: "active",
      },
    },
  ])("$name", async ({ expectedAppHost, expectedSnapshot, hostnames, refreshInput }) => {
    const { directory, provisioner } = setup({ hostnames });
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toBeNull();

    const snapshot = await provisioner.refresh({
      hostname: "garple.com",
      project,
      ...refreshInput,
    });

    expect(snapshot).toMatchObject(expectedSnapshot);
    await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
      project,
    );
    if (expectedAppHost !== undefined) {
      await expect(readProjectByHostname(directory, "counter.garple.com")).resolves.toEqual(
        expectedAppHost,
      );
    }
  });

  test("removes same-project routing KV when a refreshed hostname is no longer active", async () => {
    const { cloudflare, directory, provisioner } = setup({ hostnames: [cloudflareHostname()] });

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

  test.for([
    {
      name: "refuses to adopt a hostname routed in KV to another project",
      hostnames: [cloudflareHostname()],
      seedRegistration: otherProject,
      act: (provisioner: Provisioner) => provisioner.ensure({ hostname: "garple.com", project }),
      expectedRejection: /already routed to another project/,
      expectedRegistration: otherProject,
    },
    {
      name: "refuses to remove a hostname routed in KV to another project",
      hostnames: [cloudflareHostname()],
      seedRegistration: otherProject,
      act: (provisioner: Provisioner) =>
        provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
      expectedRejection: /already routed to another project/,
      expectedRegistration: otherProject,
    },
    {
      name: "clears a failed local custom domain without deleting an unclaimed Cloudflare hostname",
      hostnames: [cloudflareHostname()],
      act: (provisioner: Provisioner) =>
        provisioner.remove({ cloudflareHostnameId: null, hostname: "garple.com", project }),
      expectedRegistration: null,
    },
    {
      // The recorded id 404s on Cloudflare: the delete is attempted, the 404
      // swallowed as already-removed, and same-project routing still clears.
      name: "treats stale Cloudflare delete ids as already removed and clears same-project routing",
      hostnames: [],
      seedRegistration: project,
      act: (provisioner: Provisioner) =>
        provisioner.remove({ cloudflareHostnameId: "stale-id", hostname: "garple.com", project }),
      expectedDeletedIds: ["stale-id"],
      expectedRegistration: null,
    },
  ])(
    "$name",
    async ({
      act,
      expectedDeletedIds,
      expectedRegistration,
      expectedRejection,
      hostnames,
      seedRegistration,
    }) => {
      const { cloudflare, directory, provisioner } = setup({ hostnames });
      if (seedRegistration !== undefined) {
        await primeProjectHostname(directory, "garple.com", seedRegistration);
      }

      if (expectedRejection === undefined) {
        await expect(act(provisioner)).resolves.toBeUndefined();
      } else {
        await expect(act(provisioner)).rejects.toThrow(expectedRejection);
      }
      expect(cloudflare.deletedIds).toEqual(expectedDeletedIds ?? []);
      await expect(readProjectHostnameRegistration(directory, "garple.com")).resolves.toEqual(
        expectedRegistration,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Provisioner = ReturnType<typeof createProvisioner>;

/** Directory + Cloudflare fetch mock + provisioner in one call; pass `fetch`
 * to interpose on (or replace) the mock's transport. */
function setup(input: { fetch?: typeof fetch; hostnames?: CloudflareHostnameFixture[] } = {}) {
  const directory = new MemoryKv() as unknown as KVNamespace;
  const cloudflare = createCloudflareFetchMock({ hostnames: input.hostnames });
  const provisioner = createProvisioner({ directory, fetch: input.fetch ?? cloudflare.fetch });
  return { cloudflare, directory, provisioner };
}

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

type CloudflareHostnameFixture = Record<string, unknown> & {
  hostname: string;
  id: string;
  ssl?: Record<string, unknown> | null;
  status?: string;
};

function cloudflareHostname(
  input: {
    hostname?: string;
    id?: string;
    status?: "active" | "pending";
  } = {},
): CloudflareHostnameFixture {
  const hostname = input.hostname ?? "garple.com";
  const status = input.status ?? "active";
  return {
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
