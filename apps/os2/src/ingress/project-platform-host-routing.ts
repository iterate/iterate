import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { normalizeIngressHost } from "./host-routing.ts";
import type { ExactHostIngressRule } from "./types.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

type ProjectPlatformHostRow = {
  id: string;
  slug: string;
};

type ParsedProjectPlatformHost = {
  appSlug: string | null;
  projectIdentifier: string;
};

export async function getProjectPlatformHostIngressRule(input: {
  appHostname?: string | null;
  bases: readonly string[];
  db: D1Database;
  host: string;
}): Promise<ExactHostIngressRule | null> {
  const host = normalizeIngressHost(input.host);
  const appHostname = input.appHostname ? normalizeIngressHost(input.appHostname) : null;
  if (appHostname !== null && host === appHostname) return null;

  const parsedHosts = parseProjectPlatformHosts({
    bases: input.bases,
    host,
  });
  if (parsedHosts.length === 0) return null;

  let project: ProjectPlatformHostRow | null = null;
  for (const parsed of parsedHosts) {
    project = await input.db
      .prepare(`SELECT id, slug FROM projects WHERE slug = ? OR id = ? LIMIT 1`)
      .bind(parsed.projectIdentifier, parsed.projectIdentifier)
      .first<ProjectPlatformHostRow>();
    if (project) break;
  }
  if (!project) return null;

  const callable = {
    type: "fetch",
    via: {
      type: "loopback-binding",
      bindingType: "service",
      exportName: "ProjectIngressEntrypoint",
      props: { projectId: project.id },
    },
  } satisfies FetchCallable;

  return {
    id: `platform-host:${project.id}:${host}`,
    host,
    projectId: project.id,
    priority: 50,
    notes: "Project platform hostname",
    callable,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

export function parseProjectPlatformHost(input: {
  bases: readonly string[];
  host: string;
}): ParsedProjectPlatformHost | null {
  return parseProjectPlatformHosts(input)[0] ?? null;
}

export function parseProjectPlatformHosts(input: {
  bases: readonly string[];
  host: string;
}): ParsedProjectPlatformHost[] {
  const host = normalizeIngressHost(input.host);

  for (const rawBase of input.bases) {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (host === base || !host.endsWith(`.${base}`)) continue;

    const prefix = host.slice(0, host.length - base.length - 1);
    const labels = prefix.split(".").filter(Boolean);
    if (labels.length === 1) {
      return parseSingleLabelPlatformPrefix(labels[0] ?? "");
    }
    if (labels.length === 2) {
      const [appSlug, projectIdentifier] = labels;
      if (!appSlug || !projectIdentifier) return [];
      return [{ appSlug, projectIdentifier }];
    }
  }

  return [];
}

function parseSingleLabelPlatformPrefix(prefix: string): ParsedProjectPlatformHost[] {
  if (!prefix) return [];

  const separatorIndex = prefix.indexOf("__");
  if (separatorIndex === -1) return [{ appSlug: null, projectIdentifier: prefix }];
  if (separatorIndex === 0) return [];

  const appSlug = prefix.slice(0, separatorIndex);
  const projectIdentifier = prefix.slice(separatorIndex + 2);
  if (!appSlug || !projectIdentifier) return [];
  return [
    { appSlug: null, projectIdentifier: prefix },
    { appSlug, projectIdentifier },
  ];
}
