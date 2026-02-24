/**
 * Shared helpers for project ingress URL construction.
 *
 * These helpers are used by:
 * - The OS worker (alchemy.run.ts, worker.ts, project-ingress-proxy.ts, machine-creation.ts)
 * - The daemon (observability-links.ts, agent-debug-links.ts)
 * - The frontend (project-ingress-link.ts)
 *
 * ## Domain model
 *
 * Two domains configure the system:
 *
 * 1. **OS worker host** — where the control plane lives.
 *    - prod: `os.iterate.com`
 *    - dev w/ tunnel: `$DEV_TUNNEL.dev.iterate.com`
 *    - dev w/o tunnel: `os.iterate.com.localhost`
 *
 * 2. **Project ingress domain** — base domain for machine ingress.
 *    - prod: `iterate.app`
 *    - dev w/ tunnel: `$DEV_TUNNEL.dev.iterate.app`
 *    - dev w/o tunnel: `iterate.app.localhost`
 *
 * Project ingress hostnames follow the pattern:
 *    `<project-slug>.<PROJECT_INGRESS_DOMAIN>`       → port 3000 (default)
 *    `<port>__<project-slug>.<PROJECT_INGRESS_DOMAIN>` → explicit port
 *    `<machine-id>.<PROJECT_INGRESS_DOMAIN>`          → port 3000 (default)
 *    `<port>__<machine-id>.<PROJECT_INGRESS_DOMAIN>`  → explicit port
 */

const DEFAULT_TARGET_PORT = 3000;
const MAX_PORT = 65_535;
const PROJECT_SLUG_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_PROJECT_SLUGS = new Set(["prj", "org"]);

// ---------------------------------------------------------------------------
// 4a. Parse a project ingress hostname into project/machine + port
// ---------------------------------------------------------------------------

export type IngressTarget =
  | { kind: "project"; projectSlug: string; targetPort: number; isPortExplicit: boolean }
  | { kind: "machine"; machineId: string; targetPort: number; isPortExplicit: boolean };

export type ParsedIngressHostname =
  | { ok: true; target: IngressTarget; rootDomain: string }
  | { ok: false; error: "invalid_hostname" | "invalid_port" | "invalid_project_slug" };

/**
 * Parse a project ingress hostname into its target (project/machine) and port.
 *
 * Accepts:
 *   `<identifier>.<root-domain>`          → port 3000
 *   `<port>__<identifier>.<root-domain>`  → explicit port
 *
 * If identifier starts with `mach_`, it's a machine target; otherwise it's a project slug.
 */
export function parseProjectIngressHostname(hostname: string): ParsedIngressHostname {
  const normalized = hostname.toLowerCase();
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length < 3) return { ok: false, error: "invalid_hostname" };

  const token = labels[0] ?? "";
  const parsed = parseTargetToken(token);
  if (!parsed) return { ok: false, error: "invalid_port" };

  const rootDomain = labels.slice(1).join(".");

  if (parsed.identifier.startsWith("mach_")) {
    return {
      ok: true,
      target: {
        kind: "machine",
        machineId: parsed.identifier,
        targetPort: parsed.targetPort,
        isPortExplicit: parsed.isPortExplicit,
      },
      rootDomain,
    };
  }

  if (!isValidProjectSlug(parsed.identifier)) {
    return { ok: false, error: "invalid_project_slug" };
  }

  return {
    ok: true,
    target: {
      kind: "project",
      projectSlug: parsed.identifier,
      targetPort: parsed.targetPort,
      isPortExplicit: parsed.isPortExplicit,
    },
    rootDomain,
  };
}

// ---------------------------------------------------------------------------
// 4b. Produce env vars for machines
// ---------------------------------------------------------------------------

/**
 * Build the set of ingress-related env vars injected into machines.
 *
 * Returns:
 *   - `ITERATE_PROJECT_BASE_URL`        — e.g. `https://my-proj.iterate.app`
 *   - `ITERATE_OS_BASE_URL`             — e.g. `https://os.iterate.com`
 *   - `ITERATE_PROJECT_INGRESS_DOMAIN`  — e.g. `iterate.app`
 */
export function buildMachineIngressEnvVars(params: {
  projectSlug: string;
  projectIngressDomain: string;
  osBaseUrl: string;
  scheme: "http" | "https";
}): {
  ITERATE_PROJECT_BASE_URL: string;
  ITERATE_OS_BASE_URL: string;
  ITERATE_PROJECT_INGRESS_DOMAIN: string;
} {
  const { projectSlug, projectIngressDomain, osBaseUrl, scheme } = params;
  return {
    ITERATE_PROJECT_BASE_URL: `${scheme}://${projectSlug}.${projectIngressDomain}`,
    ITERATE_OS_BASE_URL: osBaseUrl,
    ITERATE_PROJECT_INGRESS_DOMAIN: projectIngressDomain,
  };
}

// ---------------------------------------------------------------------------
// 4c. Build a publicly routable project URL for a given port
// ---------------------------------------------------------------------------

/**
 * Given ITERATE_PROJECT_BASE_URL and a port, return a publicly routable URL.
 *
 * The ingress system uses `<port>__<hostname>` to route to a specific port.
 * For the default port (3000), the prefix is omitted.
 *
 * Example:
 *   projectBaseUrl = "https://my-proj.iterate.app"
 *   port = 4096
 *   → "https://4096__my-proj.iterate.app/"
 *
 *   port = 3000
 *   → "https://my-proj.iterate.app/"
 */
export function buildProjectPortUrl(params: {
  projectBaseUrl: string;
  port: number;
  path?: string;
}): string {
  const { projectBaseUrl, port, path } = params;
  const url = new URL(projectBaseUrl);
  if (port !== DEFAULT_TARGET_PORT) {
    url.hostname = `${port}__${url.hostname}`;
  }
  if (path) {
    url.pathname = path.startsWith("/") ? path : `/${path}`;
  }
  return url.toString();
}

/**
 * Build a routable URL for a specific machine (by machineId) and port.
 *
 * Example:
 *   scheme: "https", projectIngressDomain: "iterate.app", machineId: "mach_123", port: 4096
 *   → "https://4096__mach_123.iterate.app/"
 */
export function buildMachinePortUrl(params: {
  scheme: "http" | "https";
  projectIngressDomain: string;
  machineId: string;
  port: number;
  path?: string;
}): string {
  const { scheme, projectIngressDomain, machineId, port, path } = params;
  const hostname = port === DEFAULT_TARGET_PORT ? machineId : `${port}__${machineId}`;
  const normalizedPath = path ? (path.startsWith("/") ? path : `/${path}`) : "/";
  return `${scheme}://${hostname}.${projectIngressDomain}${normalizedPath}`;
}

// ---------------------------------------------------------------------------
// Domain matching helpers (used by OS worker)
// ---------------------------------------------------------------------------

/**
 * Check if a hostname is a project ingress hostname for the given domain.
 * Matches `<something>.<PROJECT_INGRESS_DOMAIN>` or `<something>.<sub>.<PROJECT_INGRESS_DOMAIN>`.
 */
export function isProjectIngressHostname(hostname: string, projectIngressDomain: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedDomain = projectIngressDomain.toLowerCase();
  // Must be a subdomain of the ingress domain (not the domain itself)
  return (
    normalizedHostname.endsWith(`.${normalizedDomain}`) &&
    normalizedHostname.length > normalizedDomain.length + 1
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseTargetToken(
  token: string,
): { identifier: string; targetPort: number; isPortExplicit: boolean } | null {
  if (!token) return null;

  const separatorIndex = token.indexOf("__");
  if (separatorIndex === -1) {
    return { identifier: token, targetPort: DEFAULT_TARGET_PORT, isPortExplicit: false };
  }

  if (separatorIndex === 0) return null;

  const rawPort = token.slice(0, separatorIndex);
  const identifier = token.slice(separatorIndex + 2);
  if (!identifier) return null;

  const port = parsePort(rawPort);
  if (!port) return null;

  return { identifier, targetPort: port, isPortExplicit: true };
}

function parsePort(rawPort: string): number | null {
  if (!/^\d+$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return null;
  return port;
}

function isValidProjectSlug(slug: string): boolean {
  return (
    PROJECT_SLUG_PATTERN.test(slug) &&
    /[a-z]/.test(slug) &&
    slug.length <= 50 &&
    !RESERVED_PROJECT_SLUGS.has(slug)
  );
}
