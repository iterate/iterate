import { z } from "zod";
import { newStyleCloudflareApps } from "../../packages/shared/src/apps/new-style-cloudflare-apps.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import { cloudflarePreviewApps } from "./apps.ts";
import {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  parseEnvironmentConfigLeaseData,
} from "./preview-inventory.ts";

type EnvironmentConfigLeaseResourceRecord = {
  slug: string;
  data: Record<string, unknown>;
  leaseState: "available" | "leased";
  leasedUntil: number | null;
};

export type PreviewReconcileClient = {
  list: (input: { type: string }) => Promise<EnvironmentConfigLeaseResourceRecord[]>;
};

type CheckResult = {
  ok: boolean;
  message?: string;
};

type CloudflareCredentialsResult =
  | {
      ok: true;
      accountId: string;
      apiToken: string;
      project: string;
    }
  | {
      ok: false;
      message: string;
      project: string;
    };

export type EnvironmentConfigLeaseReconcileIssue = {
  check: "resource-data" | "doppler-config" | "cloudflare-credentials" | "cloudflare-zone";
  message: string;
  resourceSlug: string;
};

export type EnvironmentConfigLeaseReconcileResult = {
  checkedAt: string;
  ok: boolean;
  semaphoreBaseUrl: string;
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  resources: Array<{
    dopplerConfig: string | null;
    domains: string[];
    issues: EnvironmentConfigLeaseReconcileIssue[];
    leaseState: "available" | "leased";
    leasedUntil: string | null;
    slug: string;
  }>;
  summary: {
    resourceCount: number;
    issueCount: number;
  };
};

const CloudflareZonesResponse = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z
          .object({
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    result: z
      .array(
        z
          .object({
            name: z.string(),
            account: z
              .object({
                id: z.string(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const previewManagedDopplerProjects = [
  ...new Set(Object.values(cloudflarePreviewApps).map((app) => app.dopplerProject)),
].sort();

const previewCloudflareCredentialsProject = newStyleCloudflareApps.os.dopplerProject;

export async function reconcileEnvironmentConfigLeaseResources(input: {
  checkCloudflareZone?: (input: {
    accountId: string;
    apiToken: string;
    domain: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  checkDopplerConfig?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  client: PreviewReconcileClient;
  commandEnvironment: NodeJS.ProcessEnv;
  readCloudflareCredentials?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CloudflareCredentialsResult>;
  repositoryRoot: string;
  semaphoreBaseUrl: string;
  signal?: AbortSignal;
}): Promise<EnvironmentConfigLeaseReconcileResult> {
  const checkDopplerConfig = input.checkDopplerConfig ?? checkDopplerConfigWithCli;
  const readCloudflareCredentials =
    input.readCloudflareCredentials ?? readCloudflareCredentialsWithCli;
  const checkCloudflareZone = input.checkCloudflareZone ?? checkCloudflareZoneWithApi;
  const resources = (
    await input.client.list({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    })
  ).sort((left, right) => left.slug.localeCompare(right.slug));

  const reconciledResources = [];
  for (const resource of resources) {
    const issues: EnvironmentConfigLeaseReconcileIssue[] = [];
    let dopplerConfig: string | null = null;
    let domains: string[] = [];

    try {
      const data = parseEnvironmentConfigLeaseData(resource.data);
      dopplerConfig = data.dopplerConfig;
      if (Object.keys(resource.data).length !== 1) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: "Resource data must contain only dopplerConfig.",
        });
      }
    } catch (error) {
      issues.push({
        check: "resource-data",
        resourceSlug: resource.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (dopplerConfig !== null) {
      for (const project of previewManagedDopplerProjects) {
        const configCheck = await checkDopplerConfig({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!configCheck.ok) {
          issues.push({
            check: "doppler-config",
            resourceSlug: resource.slug,
            message: `${project}/${dopplerConfig}: ${configCheck.message ?? "config check failed"}`,
          });
        }
      }

      const previewNumber = parsePreviewConfigNumber(dopplerConfig);
      if (previewNumber === null) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: `Doppler config must match preview_N, got ${dopplerConfig}.`,
        });
      } else {
        domains = [`iterate-preview-${previewNumber}.com`, `iterate-preview-${previewNumber}.app`];
        const credentials = await readCloudflareCredentials({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project: previewCloudflareCredentialsProject,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!credentials.ok) {
          issues.push({
            check: "cloudflare-credentials",
            resourceSlug: resource.slug,
            message: `${credentials.project}/${dopplerConfig}: ${credentials.message}`,
          });
        } else {
          for (const domain of domains) {
            const zoneCheck = await checkCloudflareZone({
              accountId: credentials.accountId,
              apiToken: credentials.apiToken,
              domain,
              signal: input.signal,
            });
            if (!zoneCheck.ok) {
              issues.push({
                check: "cloudflare-zone",
                resourceSlug: resource.slug,
                message: `${domain}: ${zoneCheck.message ?? "zone check failed"}`,
              });
            }
          }
        }
      }
    }

    reconciledResources.push({
      dopplerConfig,
      domains,
      issues,
      leaseState: resource.leaseState,
      leasedUntil:
        resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
      slug: resource.slug,
    });
  }

  const issueCount = reconciledResources.reduce(
    (total, resource) => total + resource.issues.length,
    0,
  );

  return {
    checkedAt: new Date().toISOString(),
    ok: issueCount === 0,
    semaphoreBaseUrl: input.semaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    resources: reconciledResources,
    summary: {
      resourceCount: resources.length,
      issueCount,
    },
  };
}

function parsePreviewConfigNumber(config: string) {
  const match = /^preview_(\d+)$/.exec(config);
  if (match?.[1] == null) return null;
  return Number.parseInt(match[1], 10);
}

async function checkDopplerConfigWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: ["configs", "get", input.config, "--project", input.project, "--json"],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, message: commandFailureSummary(result) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function readCloudflareCredentialsWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CloudflareCredentialsResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        "--project",
        input.project,
        "--config",
        input.config,
      ],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        project: input.project,
        message: commandFailureSummary(result),
      };
    }

    const secrets = z
      .object({
        CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
        CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
      })
      .passthrough()
      .parse(JSON.parse(result.stdout));

    return {
      ok: true,
      project: input.project,
      accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
      apiToken: secrets.CLOUDFLARE_API_TOKEN,
    };
  } catch (error) {
    return {
      ok: false,
      project: input.project,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCloudflareZoneWithApi(input: {
  accountId: string;
  apiToken: string;
  domain: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const url = new URL("https://api.cloudflare.com/client/v4/zones");
  url.searchParams.set("name", input.domain);
  url.searchParams.set("per_page", "50");
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${input.apiToken}`,
    },
    signal: input.signal,
  });
  const parsed = CloudflareZonesResponse.parse(await response.json());
  if (!response.ok || !parsed.success) {
    return {
      ok: false,
      message: parsed.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join("; "),
    };
  }

  const matchingZone = parsed.result.find(
    (zone) => zone.name === input.domain && zone.account?.id === input.accountId,
  );
  if (matchingZone == null) {
    return {
      ok: false,
      message: `zone not found in Cloudflare account ${input.accountId}`,
    };
  }

  return { ok: true };
}

function commandFailureSummary(result: { stderr: string; stdout: string }) {
  const output = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join("\n");
  return output || "command failed";
}
