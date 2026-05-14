import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

type CloudflareApiResponse<T> = {
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  success?: boolean;
};

type CloudflareDnsRecord = {
  content: string;
  id: string;
  name: string;
  proxied?: boolean;
  ttl?: number;
  type: string;
};

type CloudflareZone = {
  id: string;
  name: string;
};

export type ProjectWildcardDnsRecord = {
  base: string;
  name: string;
  record: CloudflareDnsRecord;
  target: string;
  zoneId: string;
  zoneName: string;
};

export async function createProjectWildcardCNAMERecord(input: {
  apiToken: string | undefined;
  projectHostnameBase: string | undefined;
  projectId: string;
  projectSlug: string;
}): Promise<ProjectWildcardDnsRecord | null> {
  const base = normalizeProjectHostnameBase(input.projectHostnameBase ?? "");

  // DNS automation is intentionally optional so local/test configs can create
  // Projects without Cloudflare credentials.
  if (!input.apiToken) {
    console.log("[ProjectDNS] Skipping wildcard CNAME creation: cloudflare.apiToken is absent.");
    return null;
  }

  // Local workerd hostnames are not Cloudflare-managed DNS zones.
  if (!base || base === "localhost" || base.endsWith(".localhost")) {
    console.log(`[ProjectDNS] Skipping wildcard CNAME creation for local base '${base}'.`);
    return null;
  }

  const zone = await resolveZone({ apiToken: input.apiToken, zoneName: base });
  const sourceRecordName = `*.${base}`;
  const sourceRecord = await getRequiredCNAMERecord({
    apiToken: input.apiToken,
    name: sourceRecordName,
    zoneId: zone.id,
  });
  const targetRecordName = `*.${input.projectSlug}.${base}`;
  const targetRecord = await createCNAMERecord({
    apiToken: input.apiToken,
    comment: `Managed by apps/os2 for project ${input.projectId}`,
    content: sourceRecord.content,
    name: targetRecordName,
    proxied: sourceRecord.proxied ?? true,
    zoneId: zone.id,
  });

  return {
    base,
    name: targetRecordName,
    record: targetRecord,
    target: sourceRecord.content,
    zoneId: zone.id,
    zoneName: zone.name,
  };
}

async function resolveZone(input: { apiToken: string; zoneName: string }) {
  const zones = await cloudflareFetch<CloudflareZone[]>({
    apiToken: input.apiToken,
    path: `/zones?name=${encodeURIComponent(input.zoneName)}&status=active&per_page=1`,
  });
  const zone = zones[0];
  if (!zone) throw new Error(`Cloudflare zone '${input.zoneName}' was not found.`);
  return zone;
}

async function getRequiredCNAMERecord(input: { apiToken: string; name: string; zoneId: string }) {
  const records = await cloudflareFetch<CloudflareDnsRecord[]>({
    apiToken: input.apiToken,
    path: `/zones/${input.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(
      input.name,
    )}&per_page=1`,
  });
  const record = records[0];
  if (!record) throw new Error(`Cloudflare CNAME '${input.name}' was not found.`);
  if (record.type !== "CNAME") throw new Error(`Cloudflare record '${input.name}' is not CNAME.`);
  return record;
}

async function createCNAMERecord(input: {
  apiToken: string;
  comment: string;
  content: string;
  name: string;
  proxied: boolean;
  zoneId: string;
}) {
  // This is deliberately create-only happy-path DNS provisioning. If the target
  // already exists or points elsewhere, Cloudflare returns an error and the
  // Project lifecycle records that failure.
  return await cloudflareFetch<CloudflareDnsRecord>({
    apiToken: input.apiToken,
    body: {
      comment: input.comment,
      content: input.content,
      name: input.name,
      proxied: input.proxied,
      ttl: 1,
      type: "CNAME",
    },
    method: "POST",
    path: `/zones/${input.zoneId}/dns_records`,
  });
}

async function cloudflareFetch<T>(input: {
  apiToken: string;
  body?: unknown;
  method?: string;
  path: string;
}): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${input.path}`, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: {
      Authorization: `Bearer ${input.apiToken}`,
      "Content-Type": "application/json",
    },
    method: input.method ?? "GET",
  });
  const payload = (await response.json()) as CloudflareApiResponse<T>;

  if (!response.ok || payload.success === false || payload.result === undefined) {
    const message = cloudflareErrorMessage(payload);
    throw new Error(`Cloudflare API request failed (${response.status} ${input.path}): ${message}`);
  }

  return payload.result;
}

function cloudflareErrorMessage(payload: CloudflareApiResponse<unknown>) {
  const messages = payload.errors
    ?.map((error) => error.message)
    .filter((message): message is string => Boolean(message));
  return messages && messages.length > 0 ? messages.join("; ") : "unknown error";
}
