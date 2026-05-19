import { createCaptunTunnel } from "captun/client";
import type { Project } from "@iterate-com/os-contract";
import { requireAdminBearerToken } from "./os-client.ts";

export const PROJECT_EGRESS_INTERCEPT_ROUTE = "/__iterate/intercept-project-egress";

export async function useProjectEgressInterceptTunnel(input: {
  baseUrl: string;
  fetch: typeof fetch;
  project: Project;
}): Promise<AsyncDisposable> {
  const url = projectEgressInterceptUrlFor({
    baseUrl: input.baseUrl,
    project: input.project,
  });
  const tunnel = await createCaptunTunnel({
    url,
    headers: {
      Authorization: `Bearer ${requireAdminBearerToken()}`,
    },
    fetch: input.fetch,
  });

  return {
    async [Symbol.asyncDispose]() {
      tunnel[Symbol.dispose]();
    },
  };
}

export function projectEgressInterceptUrlFor(input: { baseUrl: string; project: Project }) {
  const baseUrl = new URL(input.baseUrl);
  const projectHostnameBase = resolveProjectHostnameBase(baseUrl);
  return new URL(
    `${baseUrl.protocol}//${input.project.slug}.${projectHostnameBase}${PROJECT_EGRESS_INTERCEPT_ROUTE}`,
  );
}

function resolveProjectHostnameBase(baseUrl: URL) {
  const envBase = process.env.OS_E2E_PROJECT_HOSTNAME_BASE?.trim();
  if (envBase) return envBase;

  const appConfigProjectHostnameBases = readProjectHostnameBasesFromAppConfigEnv();
  if (appConfigProjectHostnameBases[0]) return appConfigProjectHostnameBases[0];

  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(baseUrl.hostname);
  if (previewMatch) return `iterate-preview-${previewMatch[1]}.app`;

  if (baseUrl.hostname === "os.iterate.com") return "iterate.app";
  if (baseUrl.hostname === "os.iterate.localhost") return "iterate.localhost";

  const devMatch = /^os\.(iterate-dev-[a-z0-9-]+)\.com$/.exec(baseUrl.hostname);
  if (devMatch) return `${devMatch[1]}.app`;

  throw new Error(
    `Cannot derive project hostname base from ${baseUrl}. Set OS_E2E_PROJECT_HOSTNAME_BASE.`,
  );
}

function readProjectHostnameBasesFromAppConfigEnv() {
  const override = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  if (override) return parseProjectHostnameBases(override);

  const rawAppConfig = process.env.APP_CONFIG?.trim();
  if (!rawAppConfig) return [];

  try {
    const appConfig = JSON.parse(rawAppConfig) as { projectHostnameBases?: unknown };
    return Array.isArray(appConfig.projectHostnameBases)
      ? appConfig.projectHostnameBases.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseProjectHostnameBases(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    return parseCommaSeparatedProjectHostnameBases(value);
  }

  return parseCommaSeparatedProjectHostnameBases(value);
}

function parseCommaSeparatedProjectHostnameBases(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
