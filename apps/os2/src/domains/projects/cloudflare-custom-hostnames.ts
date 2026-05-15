import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

type CloudflareApiResponse<T> = {
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  success?: boolean;
};

type CloudflareCustomHostname = {
  created_at?: string;
  hostname: string;
  id: string;
  ownership_verification?: {
    name?: string;
    type?: string;
    value?: string;
  };
  ssl?: {
    certificate_authority?: string;
    id?: string;
    method?: string;
    settings?: {
      min_tls_version?: string;
    };
    status?: string;
    type?: string;
    validation_errors?: unknown[];
    validation_records?: Array<{
      status?: string;
      txt_name?: string;
      txt_value?: string;
    }>;
    wildcard?: boolean;
  };
  status?: string;
  verification_errors?: string[];
};

type CloudflareZone = {
  id: string;
  name: string;
};

export type ProjectCustomHostnameStatus = {
  cloudflareConfigured: boolean;
  customHostname: string | null;
  hostnames: ProjectCustomHostnameRecord[];
  message: string | null;
  target: string | null;
};

export type ProjectCustomHostnameRecord = {
  hostname: string;
  hostnameStatus: string | null;
  id: string;
  kind: "exact";
  ownershipVerificationName: string | null;
  ownershipVerificationValue: string | null;
  sslStatus: string | null;
  validationRecords: Array<{
    status: string | null;
    txtName: string;
    txtValue: string;
  }>;
  wildcard: boolean;
};

type EnsureContext = {
  apiToken: string | undefined;
  customHostname: string | null | undefined;
  projectHostnameBase: string | undefined;
};

export async function ensureProjectCustomHostnameStatus(input: {
  apiToken: string | undefined;
  customHostname: string | null | undefined;
  projectHostnameBase: string | undefined;
}): Promise<ProjectCustomHostnameStatus> {
  const context = await resolveEnsureContext(input);
  if (context.status) return context.status;

  const rootRecord = await ensureCustomHostname({
    apiToken: context.apiToken,
    hostname: context.customHostname,
    zoneId: context.zone.id,
  });
  const relatedRecords = await listRelatedCustomHostnames({
    apiToken: context.apiToken,
    customHostname: context.customHostname,
    zoneId: context.zone.id,
  });
  const records = [rootRecord, ...relatedRecords].filter(
    (record, index, records) => records.findIndex((row) => row.id === record.id) === index,
  );

  return {
    cloudflareConfigured: true,
    customHostname: context.customHostname,
    hostnames: records.map(toProjectCustomHostnameRecord),
    message: null,
    target: context.target,
  };
}

export async function ensureProjectCustomHostname(input: EnsureContext & { hostname: string }) {
  const context = await resolveEnsureContext(input);
  if (context.status) return context.status;

  const hostname = input.hostname.trim().toLowerCase();
  if (!isProjectCustomHostname({ customHostname: context.customHostname, hostname })) {
    throw new Error(`Hostname '${hostname}' must be '${context.customHostname}' or a subdomain.`);
  }

  const record = await ensureCustomHostname({
    apiToken: context.apiToken,
    hostname,
    zoneId: context.zone.id,
  });

  return {
    cloudflareConfigured: true,
    customHostname: context.customHostname,
    hostnames: [toProjectCustomHostnameRecord(record)],
    message: null,
    target: context.target,
  };
}

async function resolveEnsureContext(input: EnsureContext): Promise<
  | {
      apiToken: string;
      customHostname: string;
      status?: never;
      target: string;
      zone: CloudflareZone;
    }
  | { status: ProjectCustomHostnameStatus }
> {
  const customHostname = input.customHostname?.trim().toLowerCase() || null;
  const base = normalizeProjectHostnameBase(input.projectHostnameBase ?? "");
  const target = base ? `cname.${base}` : null;

  if (!customHostname) {
    return {
      status: {
        cloudflareConfigured: Boolean(input.apiToken && base),
        customHostname: null,
        hostnames: [],
        message: null,
        target,
      },
    };
  }

  if (!input.apiToken) {
    return {
      status: {
        cloudflareConfigured: false,
        customHostname,
        hostnames: [],
        message: "Cloudflare API token is not configured.",
        target,
      },
    };
  }

  if (!base || base === "localhost" || base.endsWith(".localhost")) {
    return {
      status: {
        cloudflareConfigured: false,
        customHostname,
        hostnames: [],
        message: "Project hostname base is not a Cloudflare-managed zone.",
        target,
      },
    };
  }

  if (customHostname === null) {
    throw new Error("Custom hostname unexpectedly missing after validation.");
  }

  const hostname = customHostname;
  const targetHostname = target;
  if (targetHostname === null) {
    throw new Error("Cloudflare custom hostname target unexpectedly missing after validation.");
  }
  const zone = await resolveZone({ apiToken: input.apiToken, zoneName: base });
  return { apiToken: input.apiToken, customHostname: hostname, target: targetHostname, zone };
}

function isProjectCustomHostname(input: { customHostname: string; hostname: string }) {
  return (
    input.hostname === input.customHostname || input.hostname.endsWith(`.${input.customHostname}`)
  );
}

async function ensureCustomHostname(input: {
  apiToken: string;
  hostname: string;
  zoneId: string;
}): Promise<CloudflareCustomHostname> {
  const existing = await findCustomHostname(input);
  if (existing) return existing;

  return await createCustomHostname(input);
}

async function findCustomHostname(input: { apiToken: string; hostname: string; zoneId: string }) {
  const url = new URL(`${CLOUDFLARE_API_BASE}/zones/${input.zoneId}/custom_hostnames`);
  url.searchParams.set("hostname", input.hostname);
  const rows = await cloudflareFetch<CloudflareCustomHostname[]>({
    apiToken: input.apiToken,
    url,
  });
  return rows.find((row) => row.hostname === input.hostname) ?? null;
}

async function createCustomHostname(input: { apiToken: string; hostname: string; zoneId: string }) {
  try {
    return await cloudflareFetch<CloudflareCustomHostname>({
      apiToken: input.apiToken,
      body: {
        hostname: input.hostname,
        ssl: {
          method: "txt",
          settings: {
            min_tls_version: "1.0",
          },
          type: "dv",
        },
      },
      method: "POST",
      url: new URL(`${CLOUDFLARE_API_BASE}/zones/${input.zoneId}/custom_hostnames`),
    });
  } catch (error) {
    const existing = await findCustomHostname(input);
    if (existing) return existing;
    throw error;
  }
}

async function listRelatedCustomHostnames(input: {
  apiToken: string;
  customHostname: string;
  zoneId: string;
}) {
  const url = new URL(`${CLOUDFLARE_API_BASE}/zones/${input.zoneId}/custom_hostnames`);
  url.searchParams.set("per_page", "100");
  const records = await cloudflareFetch<CloudflareCustomHostname[]>({
    apiToken: input.apiToken,
    url,
  });
  return records.filter((record) =>
    isProjectCustomHostname({ customHostname: input.customHostname, hostname: record.hostname }),
  );
}

async function resolveZone(input: { apiToken: string; zoneName: string }) {
  const url = new URL(`${CLOUDFLARE_API_BASE}/zones`);
  url.searchParams.set("name", input.zoneName);
  url.searchParams.set("status", "active");
  url.searchParams.set("per_page", "1");
  const zones = await cloudflareFetch<CloudflareZone[]>({
    apiToken: input.apiToken,
    url,
  });
  const zone = zones[0];
  if (!zone) throw new Error(`Cloudflare zone '${input.zoneName}' was not found.`);
  return zone;
}

async function cloudflareFetch<T>(input: {
  apiToken: string;
  body?: unknown;
  method?: string;
  url: URL;
}): Promise<T> {
  const response = await fetch(input.url, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: {
      Authorization: `Bearer ${input.apiToken}`,
      "Content-Type": "application/json",
    },
    method: input.method ?? "GET",
  });
  const payload = (await response.json()) as CloudflareApiResponse<T>;

  if (!response.ok || payload.success === false || payload.result === undefined) {
    throw new Error(
      `Cloudflare custom hostname request failed (${response.status} ${input.url.pathname}): ${cloudflareErrorMessage(
        payload,
      )}`,
    );
  }

  return payload.result;
}

function cloudflareErrorMessage(payload: CloudflareApiResponse<unknown>) {
  const messages = payload.errors
    ?.map((error) => error.message)
    .filter((message): message is string => Boolean(message));
  return messages && messages.length > 0 ? messages.join("; ") : "unknown error";
}

function toProjectCustomHostnameRecord(
  input: CloudflareCustomHostname,
): ProjectCustomHostnameRecord {
  return {
    hostname: input.hostname,
    hostnameStatus: input.status ?? null,
    id: input.id,
    kind: "exact",
    ownershipVerificationName: input.ownership_verification?.name ?? null,
    ownershipVerificationValue: input.ownership_verification?.value ?? null,
    sslStatus: input.ssl?.status ?? null,
    validationRecords: (input.ssl?.validation_records ?? []).flatMap((record) => {
      if (!record.txt_name || !record.txt_value) return [];
      return [
        {
          status: record.status ?? null,
          txtName: record.txt_name,
          txtValue: record.txt_value,
        },
      ];
    }),
    wildcard: input.ssl?.wildcard ?? false,
  };
}
