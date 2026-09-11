// ingress.ts — deployment-owned hostname routing. This module only identifies a project; callers
// retain the original Request and hand it to that root context's normal `itx.fetch` policy.

export type ProjectHostDirectory = {
  projectHostnameBase: string;
  projects: Readonly<Record<string, string>>;
  customHostnames: Readonly<Record<string, string>>;
};

export type ProjectHostResolution =
  | { kind: "project"; projectId: string; app: string | null }
  | { kind: "unknown" }
  | null;

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

/** Resolve a hostname from deployment-owned names. A complete project slug wins over an app prefix. */
export function resolveProjectHost(
  url: URL,
  directory: ProjectHostDirectory,
): ProjectHostResolution {
  const host = normalizeHostname(url.hostname);
  const base = normalizeHostname(directory.projectHostnameBase);
  const platformSuffix = `.${base}`;

  // A registered custom hostname is more specific than a deployment wildcard. This matters for a
  // local custom name such as `custom.localhost`, and for a deployed custom name under its base.
  if (Object.hasOwn(directory.customHostnames, host))
    return { kind: "project", projectId: directory.customHostnames[host]!, app: null };

  const customDomains = Object.keys(directory.customHostnames).sort((a, b) => b.length - a.length);
  for (const domain of customDomains) {
    if (!host.endsWith(`.${domain}`)) continue;
    const app = host.slice(0, -domain.length - 1);
    if (app && !app.includes("."))
      return { kind: "project", projectId: directory.customHostnames[domain]!, app };
  }

  if (host.endsWith(platformSuffix)) {
    const label = host.slice(0, -platformSuffix.length);
    if (!label.includes(".")) {
      if (Object.hasOwn(directory.projects, label))
        return { kind: "project", projectId: directory.projects[label]!, app: null };

      const slugs = Object.keys(directory.projects).sort((a, b) => b.length - a.length);
      for (const slug of slugs) {
        for (const separator of ["--", "-"]) {
          const suffix = `${separator}${slug}`;
          if (!label.endsWith(suffix)) continue;
          const app = label.slice(0, -suffix.length);
          if (app) return { kind: "project", projectId: directory.projects[slug]!, app };
        }
      }
    }
    return { kind: "unknown" };
  }

  return null;
}
