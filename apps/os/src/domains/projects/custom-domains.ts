import type { AppConfig } from "../../config.ts";
import {
  deleteProjectHostname,
  primeProjectHostname,
  readProjectByHostname,
  readProjectHostnameRegistration,
  type ProjectDirectoryRecord,
} from "../../project-directory.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
} from "../../lib/project-host-routing.ts";
import type { ProjectCustomDomainCloudflareSnapshot } from "./project-processor-contract.ts";

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

type CloudflareValidationRecord = {
  name?: unknown;
  status?: unknown;
  txt_name?: unknown;
  txt_value?: unknown;
  value?: unknown;
};

type CloudflareCustomHostname = {
  custom_metadata?: Record<string, unknown> | null;
  errors?: CloudflareError[];
  hostname?: string;
  id?: string;
  ownership_verification?: {
    name?: unknown;
    value?: unknown;
  } | null;
  ssl?: {
    errors?: CloudflareError[];
    status?: string;
    validation_records?: CloudflareValidationRecord[];
    wildcard?: boolean;
  } | null;
  status?: string;
};

export type ProjectCustomDomainProvisioner = {
  ensure(input: {
    hostname: string;
    project: ProjectDirectoryRecord;
  }): Promise<ProjectCustomDomainCloudflareSnapshot>;
  refresh(input: {
    hostname: string;
    project: ProjectDirectoryRecord;
  }): Promise<ProjectCustomDomainCloudflareSnapshot>;
  remove(input: {
    cloudflareHostnameId?: string | null;
    hostname: string;
    project: ProjectDirectoryRecord;
  }): Promise<void>;
};

export function normalizeProjectCustomDomain(input: {
  hostname: string;
  projectHostnameBases: readonly string[];
}): string {
  const hostname = normalizeCustomHostname(input.hostname);
  if (!hostname || !isValidCustomHostname(hostname)) {
    throw new Error("Enter a valid DNS hostname, such as garple.com.");
  }
  if (isReservedProjectHostname(hostname, input.projectHostnameBases)) {
    throw new Error(`"${hostname}" is reserved for Iterate project hostnames.`);
  }
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
      await assertHostnameAvailable({
        directory: options.directory,
        hostname: normalized,
        projectId: project.id,
      });

      const client = await cloudflareClient({ config: options.config, fetch: fetcher });
      const existing = await client.findCustomHostname(normalized);
      if (existing) assertCloudflareHostnameBelongsToProject(existing, project);
      const customHostname =
        existing ??
        (await createCustomHostnameWithDuplicateRecovery({
          client,
          hostname: normalized,
          project,
        }));

      const snapshot = await snapshotCustomHostname({
        client,
        customHostname,
        fallbackHostname: normalized,
      });
      await reconcileProjectHostnameRegistration({
        directory: options.directory,
        hostname: normalized,
        project,
        snapshot,
      });
      return snapshot;
    },

    async refresh({ hostname, project }) {
      const normalized = normalizeProjectCustomDomain({
        hostname,
        projectHostnameBases: options.config.projectHostnameBases ?? [],
      });
      const client = await cloudflareClient({ config: options.config, fetch: fetcher });
      const customHostname = await client.findCustomHostname(normalized);
      if (!customHostname) {
        throw new Error(`Cloudflare custom hostname "${normalized}" was not found.`);
      }
      assertCloudflareHostnameBelongsToProject(customHostname, project);
      const snapshot = await snapshotCustomHostname({
        client,
        customHostname,
        fallbackHostname: normalized,
      });
      await reconcileProjectHostnameRegistration({
        directory: options.directory,
        hostname: normalized,
        project,
        snapshot,
      });
      return snapshot;
    },

    async remove({ cloudflareHostnameId, hostname, project }) {
      const normalized = normalizeProjectCustomDomain({
        hostname,
        projectHostnameBases: options.config.projectHostnameBases ?? [],
      });
      await assertProjectHostnameRegistrationBelongsToProject({
        directory: options.directory,
        hostname: normalized,
        projectId: project.id,
      });
      const client = await cloudflareClient({ config: options.config, fetch: fetcher });
      const customHostname = await client.findCustomHostname(normalized);
      if (customHostname) assertCloudflareHostnameBelongsToProject(customHostname, project);
      const id = cloudflareHostnameId ?? customHostname?.id ?? null;
      if (id) await client.deleteCustomHostname(id);
      const registeredProject = await readProjectHostnameRegistration(
        options.directory,
        normalized,
      );
      if (registeredProject?.id === project.id) {
        await deleteProjectHostname(options.directory, normalized);
      }
    },
  };
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
  if (exact) return;

  const covered = await readProjectByHostname(input.directory, input.hostname);
  if (covered) {
    throw new Error(
      `"${input.hostname}" is already covered by ${
        covered.appSlug === null ? "a custom domain" : "a custom-domain app route"
      }.`,
    );
  }
}

async function createCustomHostnameWithDuplicateRecovery(input: {
  client: Awaited<ReturnType<typeof cloudflareClient>>;
  hostname: string;
  project: ProjectDirectoryRecord;
}): Promise<CloudflareCustomHostname> {
  try {
    return await input.client.createCustomHostname({
      hostname: input.hostname,
      metadata: {
        projectId: input.project.id,
        projectSlug: input.project.slug,
        source: "iterate-os",
      },
    });
  } catch (error) {
    const existing = await input.client.findCustomHostname(input.hostname).catch(() => null);
    if (existing) {
      assertCloudflareHostnameBelongsToProject(existing, input.project);
      return existing;
    }
    throw error;
  }
}

async function snapshotCustomHostname(input: {
  client: Awaited<ReturnType<typeof cloudflareClient>>;
  customHostname: CloudflareCustomHostname;
  fallbackHostname: string;
}): Promise<ProjectCustomDomainCloudflareSnapshot> {
  const customHostname = await fetchCustomHostnameDetails(input.client, input.customHostname);
  return toProjectCustomDomainCloudflareSnapshot(customHostname, input.fallbackHostname, {
    dcvDelegationUuid: await input.client.getDcvDelegationUuid(),
  });
}

async function fetchCustomHostnameDetails(
  client: Awaited<ReturnType<typeof cloudflareClient>>,
  customHostname: CloudflareCustomHostname,
): Promise<CloudflareCustomHostname> {
  const id = stringValue(customHostname.id);
  if (!id) return customHostname;
  return await client.getCustomHostname(id).catch(() => customHostname);
}

async function reconcileProjectHostnameRegistration(input: {
  directory: KVNamespace;
  hostname: string;
  project: ProjectDirectoryRecord;
  snapshot: ProjectCustomDomainCloudflareSnapshot;
}): Promise<void> {
  if (input.snapshot.status !== "active") {
    const registeredProject = await readProjectHostnameRegistration(
      input.directory,
      input.hostname,
    );
    if (registeredProject?.id === input.project.id) {
      await deleteProjectHostname(input.directory, input.hostname);
    }
    return;
  }

  await assertHostnameAvailable({
    directory: input.directory,
    hostname: input.hostname,
    projectId: input.project.id,
  });
  await primeProjectHostname(input.directory, input.hostname, input.project);
}

async function assertProjectHostnameRegistrationBelongsToProject(input: {
  directory: KVNamespace;
  hostname: string;
  projectId: string;
}): Promise<void> {
  const registeredProject = await readProjectHostnameRegistration(input.directory, input.hostname);
  if (registeredProject && registeredProject.id !== input.projectId) {
    throw new Error(`"${input.hostname}" is already routed to another project.`);
  }
}

function assertCloudflareHostnameBelongsToProject(
  customHostname: CloudflareCustomHostname,
  project: ProjectDirectoryRecord,
): void {
  const projectId = stringValue(customHostname.custom_metadata?.projectId);
  if (projectId === project.id) return;
  const hostname = customHostname.hostname ?? "custom hostname";
  throw new Error(`Cloudflare custom hostname "${hostname}" is already owned by another project.`);
}

async function cloudflareClient(input: { config: AppConfig; fetch: Fetch }) {
  const token = input.config.cloudflare.apiToken?.exposeSecret();
  if (!token) throw new Error("Cloudflare API token is not configured.");
  const accountId = input.config.cloudflare.accountId;
  if (!accountId) throw new Error("Cloudflare account id is not configured.");

  const zoneName = projectHostnameZoneName(input.config);
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await input.fetch(`https://api.cloudflare.com/client/v4${path}`, {
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
  let dcvDelegationUuid: Promise<string | null> | undefined;

  return {
    async createCustomHostname(input: {
      hostname: string;
      metadata: Record<string, string>;
    }): Promise<CloudflareCustomHostname> {
      return await request<CloudflareCustomHostname>(`/zones/${zone.id}/custom_hostnames`, {
        method: "POST",
        body: JSON.stringify({
          hostname: input.hostname,
          custom_metadata: input.metadata,
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

    async getCustomHostname(id: string): Promise<CloudflareCustomHostname> {
      return await request<CloudflareCustomHostname>(
        `/zones/${zone.id}/custom_hostnames/${encodeURIComponent(id)}`,
      );
    },

    async findCustomHostname(hostname: string): Promise<CloudflareCustomHostname | null> {
      const result = await request<CloudflareCustomHostname[]>(
        `/zones/${zone.id}/custom_hostnames?hostname.exact=${encodeURIComponent(hostname)}&per_page=50`,
      );
      return result.find((candidate) => candidate.hostname === hostname) ?? null;
    },

    getDcvDelegationUuid(): Promise<string | null> {
      dcvDelegationUuid ??= request<{ uuid?: unknown }>(`/zones/${zone.id}/dcv_delegation/uuid`)
        .then((result) => stringValue(result.uuid))
        .catch((error) => {
          console.warn("Cloudflare DCV delegation lookup failed", error);
          return null;
        });
      return dcvDelegationUuid;
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

export function toProjectCustomDomainCloudflareSnapshot(
  customHostname: CloudflareCustomHostname,
  fallbackHostname: string,
  options: { dcvDelegationUuid?: string | null } = {},
): ProjectCustomDomainCloudflareSnapshot {
  const hostname =
    typeof customHostname.hostname === "string" ? customHostname.hostname : fallbackHostname;
  const hostnameStatus = customHostname.status ?? null;
  const sslStatus = customHostname.ssl?.status ?? null;
  const validationRecords = (customHostname.ssl?.validation_records ?? [])
    .map(toValidationRecord)
    .filter(
      (record): record is NonNullable<ReturnType<typeof toValidationRecord>> => record !== null,
    );
  const error = [...(customHostname.errors ?? []), ...(customHostname.ssl?.errors ?? [])]
    .map((entry) => entry.message)
    .filter((value): value is string => Boolean(value))
    .join("; ");

  return {
    certificateDelegationCname: toCertificateDelegationRecord({
      hostname,
      uuid: options.dcvDelegationUuid ?? null,
    }),
    cloudflareHostnameId: customHostname.id ?? null,
    error: error || null,
    hostname,
    hostnameStatus,
    ownershipVerification: toOwnershipVerification(customHostname.ownership_verification),
    sslStatus,
    status: customDomainStatus({ error, hostnameStatus, sslStatus }),
    validationRecords,
    wildcard: customHostname.ssl?.wildcard === true,
  };
}

function toCertificateDelegationRecord(input: {
  hostname: string;
  uuid: string | null;
}): { name: string; value: string } | null {
  if (!input.uuid) return null;
  return {
    name: `_acme-challenge.${input.hostname}`,
    value: `${input.hostname}.${input.uuid}.dcv.cloudflare.com`,
  };
}

function toValidationRecord(
  record: CloudflareValidationRecord,
): { name: string; status: string | null; value: string } | null {
  const name = stringValue(record.txt_name) ?? stringValue(record.name);
  const value = stringValue(record.txt_value) ?? stringValue(record.value);
  if (!name || !value) return null;
  return { name, status: stringValue(record.status), value };
}

function toOwnershipVerification(
  value: CloudflareCustomHostname["ownership_verification"],
): { name: string; value: string } | null {
  const name = stringValue(value?.name);
  const verificationValue = stringValue(value?.value);
  return name && verificationValue ? { name, value: verificationValue } : null;
}

function customDomainStatus(input: {
  error: string;
  hostnameStatus: string | null;
  sslStatus: string | null;
}): ProjectCustomDomainCloudflareSnapshot["status"] {
  if (input.hostnameStatus === "active" && input.sslStatus === "active") return "active";
  if (input.error) return "failed";

  const failedStatuses = new Set(["deleted", "expired", "failed", "validation_timed_out"]);
  if (
    (input.hostnameStatus && failedStatuses.has(input.hostnameStatus)) ||
    (input.sslStatus && failedStatuses.has(input.sslStatus))
  ) {
    return "failed";
  }

  const pendingStatuses = new Set([
    "initializing",
    "pending",
    "pending_deployment",
    "pending_validation",
  ]);
  if (
    (input.hostnameStatus && pendingStatuses.has(input.hostnameStatus)) ||
    (input.sslStatus && pendingStatuses.has(input.sslStatus))
  ) {
    return "pending_validation";
  }

  return "provisioning";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
