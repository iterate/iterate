import type { AppConfig } from "../../config.ts";
import { parseConfig } from "../../config.ts";
import type { Env } from "../../env.ts";
import {
  deleteProjectHostname,
  listProjectHostnameRegistrationsUnder,
  primeProjectHostname,
  readProjectByHostname,
  readProjectHostnameRegistration,
} from "../../project-hostname-directory.ts";
import { readProjectById, type ProjectDirectoryRecord } from "../../project-directory.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
} from "../../lib/project-host-routing.ts";

type Fetch = typeof fetch;

type CloudflareError = {
  code?: number;
  message?: string;
};

class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type CloudflareCustomHostname = {
  hostname?: string;
  id?: string;
};

export type ProjectCustomDomainProvisioner = {
  ensure(input: { hostname: string; project: ProjectDirectoryRecord }): Promise<void>;
  remove(input: { hostname: string; project: ProjectDirectoryRecord }): Promise<void>;
};

export type ProjectCustomDomainDeps = ProjectCustomDomainProvisioner & {
  readProject(): Promise<ProjectDirectoryRecord | null>;
};

export function createCloudflareProjectCustomDomainDeps(options: {
  env: Env;
  projectId: string;
}): ProjectCustomDomainDeps {
  return {
    ...createCloudflareCustomDomainProvisioner({
      config: parseConfig(options.env),
      directory: options.env.PROJECT_DIRECTORY,
    }),
    readProject: () => readProjectById(options.env.PROJECT_DIRECTORY, options.projectId),
  };
}

export function normalizeProjectCustomDomain(input: {
  hostname: string;
  projectHostnameBases: readonly string[];
}): string {
  const hostname = normalizeCustomHostname(input.hostname);
  if (!hostname || !isValidCustomHostname(hostname)) {
    throw new Error("Enter a valid DNS hostname, such as garple.com.");
  }
  if (isReservedProjectHostname(hostname, input.projectHostnameBases)) {
    throw new Error(`"${hostname}" is reserved for iterate project hostnames.`);
  }
  return hostname;
}

/**
 * Record the routing half of a platform-owned apex that already reaches this
 * worker through ordinary Worker routes. This does not provision Cloudflare
 * for SaaS; the caller separately records the small project catalog entry.
 */
export async function primeDirectProjectCustomDomain(input: {
  directory: KVNamespace;
  hostname: string;
  project: ProjectDirectoryRecord;
  projectHostnameBases: readonly string[];
}): Promise<string> {
  const hostname = normalizeProjectCustomDomain(input);
  await claimProjectHostname({
    directory: input.directory,
    hostname,
    project: input.project,
  });
  return hostname;
}

export function createCloudflareCustomDomainProvisioner(options: {
  config: AppConfig;
  directory: KVNamespace;
  fetch?: Fetch;
}): ProjectCustomDomainProvisioner {
  const fetcher = options.fetch ?? fetch;

  return {
    async ensure({ hostname, project }) {
      const normalized = normalizeProjectCustomDomain({
        hostname,
        projectHostnameBases: options.config.projectHostnameBases ?? [],
      });
      await claimProjectHostname({
        directory: options.directory,
        hostname: normalized,
        project,
      });

      const client = await cloudflareClient({ config: options.config, fetch: fetcher });
      const existing = await client.findCustomHostname(normalized);
      const customHostname =
        existing ??
        (await createCustomHostnameWithDuplicateRecovery({
          client,
          hostname: normalized,
        }));
      assertCloudflareHostnameMatches(customHostname, normalized);
      await assertProjectHostnameClaim(options.directory, normalized, project.id);
    },

    async remove({ hostname, project }) {
      const normalized = normalizeProjectCustomDomain({
        hostname,
        projectHostnameBases: options.config.projectHostnameBases ?? [],
      });
      const registeredProject = await readProjectHostnameRegistration(
        options.directory,
        normalized,
      );
      if (registeredProject === null) return;
      if (registeredProject.id !== project.id) {
        throw new Error(`"${normalized}" is already routed to another project.`);
      }

      const client = await cloudflareClient({ config: options.config, fetch: fetcher });
      const customHostname = await client.findCustomHostname(normalized);
      await assertProjectHostnameClaim(options.directory, normalized, project.id);
      if (customHostname) {
        assertCloudflareHostnameMatches(customHostname, normalized);
        const id = stringValue(customHostname.id);
        if (!id) {
          throw new Error(`Cloudflare custom hostname "${normalized}" has no id.`);
        }
        await client.deleteCustomHostname(id);
      }
      await assertProjectHostnameClaim(options.directory, normalized, project.id);
      await deleteProjectHostname(options.directory, normalized);
    },
  };
}

async function claimProjectHostname(input: {
  directory: KVNamespace;
  hostname: string;
  project: ProjectDirectoryRecord;
}): Promise<void> {
  await assertHostnameAvailable({
    directory: input.directory,
    hostname: input.hostname,
    projectId: input.project.id,
  });
  await primeProjectHostname(input.directory, input.hostname, input.project);
  await assertProjectHostnameClaim(input.directory, input.hostname, input.project.id);
}

async function assertProjectHostnameClaim(
  directory: KVNamespace,
  hostname: string,
  projectId: string,
): Promise<void> {
  const registration = await readProjectHostnameRegistration(directory, hostname);
  if (registration?.id !== projectId) {
    throw new Error(`Custom hostname "${hostname}" is not registered for ${projectId}.`);
  }
}

async function assertHostnameAvailable(input: {
  directory: KVNamespace;
  hostname: string;
  projectId: string;
}): Promise<void> {
  const exact = await readProjectHostnameRegistration(input.directory, input.hostname);
  if (exact && exact.id !== input.projectId) {
    throw new Error(`"${input.hostname}" is already routed to another project.`);
  }

  const covered = await readProjectByHostname(input.directory, input.hostname);
  if (covered && covered.record.id !== input.projectId) {
    throw new Error(
      `"${input.hostname}" is already covered by ${
        covered.appSlug === null ? "a custom domain" : "a custom-domain app route"
      }.`,
    );
  }

  const child = (await listProjectHostnameRegistrationsUnder(input.directory, input.hostname)).find(
    (registration) => registration.record.id !== input.projectId,
  );
  if (child) {
    throw new Error(
      `"${input.hostname}" overlaps existing custom domain "${child.hostname}" routed to another project.`,
    );
  }
}

async function createCustomHostnameWithDuplicateRecovery(input: {
  client: Awaited<ReturnType<typeof cloudflareClient>>;
  hostname: string;
}): Promise<CloudflareCustomHostname> {
  try {
    return await input.client.createCustomHostname({ hostname: input.hostname });
  } catch (error) {
    const existing = await input.client.findCustomHostname(input.hostname).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

function assertCloudflareHostnameMatches(
  customHostname: CloudflareCustomHostname,
  expectedHostname: string,
): void {
  const actualHostname = stringValue(customHostname.hostname);
  if (actualHostname === expectedHostname) return;
  throw new Error(
    `Cloudflare custom hostname "${actualHostname ?? "unknown"}" does not match "${expectedHostname}".`,
  );
}

async function cloudflareClient(input: { config: AppConfig; fetch: Fetch }) {
  const token = input.config.cloudflare.apiToken?.exposeSecret();
  if (!token) throw new Error("Cloudflare API token is not configured.");
  const accountId = input.config.cloudflare.accountId;
  if (!accountId) throw new Error("Cloudflare account id is not configured.");

  const zoneName = projectHostnameZoneName(input.config);
  const fetcher = input.fetch;
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      errors?: CloudflareError[];
      result?: T;
      success?: boolean;
    };
    if (!response.ok || body.success === false) {
      throw new CloudflareApiError(
        cloudflareErrorMessage(path, response.status, body.errors),
        response.status,
      );
    }
    return body.result as T;
  };

  const zones = await request<Array<{ id: string; name: string }>>(
    `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(zoneName)}&per_page=5`,
  );
  const zone = zones.find((candidate) => candidate.name === zoneName);
  if (!zone) throw new Error(`Cloudflare zone "${zoneName}" was not found.`);
  return {
    async createCustomHostname(input: { hostname: string }): Promise<CloudflareCustomHostname> {
      return await request<CloudflareCustomHostname>(`/zones/${zone.id}/custom_hostnames`, {
        method: "POST",
        body: JSON.stringify({
          hostname: input.hostname,
          ssl: {
            method: "txt",
            settings: { min_tls_version: "1.2" },
            type: "dv",
            wildcard: true,
          },
        }),
      });
    },

    async deleteCustomHostname(id: string): Promise<void> {
      try {
        await request<unknown>(`/zones/${zone.id}/custom_hostnames/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return;
        throw error;
      }
    },

    async findCustomHostname(hostname: string): Promise<CloudflareCustomHostname | null> {
      const result = await request<CloudflareCustomHostname[]>(
        `/zones/${zone.id}/custom_hostnames?hostname.exact=${encodeURIComponent(hostname)}&per_page=50`,
      );
      return result.find((candidate) => candidate.hostname === hostname) ?? null;
    },
  };
}

function projectHostnameZoneName(config: AppConfig): string {
  for (const rawBase of config.projectHostnameBases ?? []) {
    const base = normalizeProjectHostnameBase(rawBase);
    if (isValidCustomHostname(base)) return base;
  }
  throw new Error("Custom domains require a deployed DNS project hostname base.");
}

function cloudflareErrorMessage(path: string, status: number, errors: CloudflareError[] = []) {
  const message = errors
    .map((error) => error.message)
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return `Cloudflare ${path} failed with ${status}${message ? `: ${message}` : ""}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
