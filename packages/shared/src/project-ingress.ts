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

/**
 * Named service aliases — map friendly subdomain names to port numbers.
 * e.g. `opencode.templestein.com` → port 4096
 *
 * Used for:
 * - Parsing: `opencode.templestein.com` → port 4096
 * - Generation: port 4096 → `opencode.templestein.com` (first alias wins)
 */
export const SERVICE_ALIASES: Record<string, number> = {
  opencode: 4096,
  terminal: 4096,
};

/**
 * Reverse map: port → preferred alias name (first alias for each port wins).
 * Used by URL builders to emit `opencode.templestein.com` instead of `4096.templestein.com`.
 */
export const PORT_TO_ALIAS: Record<number, string> = {};
for (const [name, port] of Object.entries(SERVICE_ALIASES)) {
  if (!(port in PORT_TO_ALIAS)) PORT_TO_ALIAS[port] = name;
}

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
// 4a-bis. Parse a custom domain hostname into target + port
// ---------------------------------------------------------------------------

export type CustomDomainTarget =
  | { kind: "project"; targetPort: number }
  | { kind: "machine"; machineId: string; targetPort: number };

export type ParsedCustomDomainHostname =
  | { ok: true; target: CustomDomainTarget }
  | { ok: false; error: "not_custom_domain" | "invalid_subdomain" };

/**
 * Parse a hostname against a known custom domain.
 *
 * Custom domain hostnames:
 *   `templestein.com`                     → project, port 3000
 *   `4096.templestein.com`                → project, port 4096
 *   `opencode.templestein.com`            → project, port from SERVICE_ALIASES
 *   `4096__mach_abc.templestein.com`      → machine mach_abc, port 4096
 *   `mach_abc.templestein.com`            → machine mach_abc, port 3000
 *
 * Returns `{ ok: false, error: "not_custom_domain" }` if the hostname
 * is not the custom domain or a subdomain of it.
 */
export function parseCustomDomainHostname(
  hostname: string,
  customDomain: string,
): ParsedCustomDomainHostname {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedCustomDomain = customDomain.toLowerCase();

  // Exact match — root custom domain, port 3000
  if (normalizedHostname === normalizedCustomDomain) {
    return { ok: true, target: { kind: "project", targetPort: DEFAULT_TARGET_PORT } };
  }

  // Must be a subdomain of the custom domain
  if (!normalizedHostname.endsWith(`.${normalizedCustomDomain}`)) {
    return { ok: false, error: "not_custom_domain" };
  }

  // Extract the subdomain label (everything before the custom domain)
  const subdomainPart = normalizedHostname.slice(
    0,
    normalizedHostname.length - normalizedCustomDomain.length - 1,
  );

  // Only support single-level subdomains (e.g. "4096" but not "a.b")
  // Exception: machine-targeting with port (e.g. "4096__mach_abc")
  if (!subdomainPart || subdomainPart.includes(".")) {
    return { ok: false, error: "invalid_subdomain" };
  }

  // Check for machine target with port prefix: `4096__mach_abc`
  const separatorIndex = subdomainPart.indexOf("__");
  if (separatorIndex > 0) {
    const rawPort = subdomainPart.slice(0, separatorIndex);
    const identifier = subdomainPart.slice(separatorIndex + 2);
    const port = parsePort(rawPort);
    if (port && identifier.startsWith("mach_")) {
      return { ok: true, target: { kind: "machine", machineId: identifier, targetPort: port } };
    }
    // Invalid format
    return { ok: false, error: "invalid_subdomain" };
  }

  // Check for machine target without port: `mach_abc`
  if (subdomainPart.startsWith("mach_")) {
    return {
      ok: true,
      target: { kind: "machine", machineId: subdomainPart, targetPort: DEFAULT_TARGET_PORT },
    };
  }

  // Check for service alias: `opencode`
  const aliasPort = SERVICE_ALIASES[subdomainPart];
  if (aliasPort !== undefined) {
    return { ok: true, target: { kind: "project", targetPort: aliasPort } };
  }

  // Check for numeric port: `4096`
  const port = parsePort(subdomainPart);
  if (port) {
    return { ok: true, target: { kind: "project", targetPort: port } };
  }

  return { ok: false, error: "invalid_subdomain" };
}

/**
 * Check if a hostname is a custom domain or subdomain of one.
 */
export function isCustomDomainHostname(hostname: string, customDomain: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedCustomDomain = customDomain.toLowerCase();
  return (
    normalizedHostname === normalizedCustomDomain ||
    normalizedHostname.endsWith(`.${normalizedCustomDomain}`)
  );
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
 *
 * When `customDomain` is set, the base URL and ingress domain use the custom
 * domain instead of `<slug>.<ingressDomain>`.
 */
export function buildMachineIngressEnvVars(params: {
  projectSlug: string;
  projectIngressDomain: string;
  osBaseUrl: string;
  scheme: "http" | "https";
  customDomain?: string | null;
}): {
  ITERATE_PROJECT_BASE_URL: string;
  ITERATE_OS_BASE_URL: string;
  ITERATE_PROJECT_INGRESS_DOMAIN: string;
} {
  const { projectSlug, projectIngressDomain, osBaseUrl, scheme, customDomain } = params;

  if (customDomain) {
    return {
      ITERATE_PROJECT_BASE_URL: `${scheme}://${customDomain}`,
      ITERATE_OS_BASE_URL: osBaseUrl,
      ITERATE_PROJECT_INGRESS_DOMAIN: customDomain,
    };
  }

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
 * For standard ingress domains (`*.iterate.app`), uses `<port>__<hostname>`.
 * For custom domains, uses `<port>.<hostname>` (dot subdomain).
 * For the default port (3000), the prefix is omitted in both cases.
 *
 * Example (standard):
 *   projectBaseUrl = "https://my-proj.iterate.app"
 *   port = 4096
 *   → "https://4096__my-proj.iterate.app/"
 *
 * Example (custom domain):
 *   projectBaseUrl = "https://templestein.com"
 *   port = 4096
 *   → "https://opencode.templestein.com/"  (uses SERVICE_ALIASES)
 */
export function buildProjectPortUrl(params: {
  projectBaseUrl: string;
  port: number;
  path?: string;
}): string {
  const { projectBaseUrl, port, path } = params;
  const url = new URL(projectBaseUrl);
  if (port !== DEFAULT_TARGET_PORT) {
    const isStandardIngress = isStandardIngressDomain(url.hostname);
    if (isStandardIngress) {
      url.hostname = `${port}__${url.hostname}`;
    } else {
      // Custom domains: prefer named alias (opencode) over numeric port (4096)
      const alias = PORT_TO_ALIAS[port];
      url.hostname = `${alias ?? port}.${url.hostname}`;
    }
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

/**
 * Standard ingress domains end with `.iterate.app` (or dev variants like `.iterate.app.localhost`).
 * Anything else is a custom domain that uses dot-separated subdomains for port routing.
 */
function isStandardIngressDomain(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".iterate.app") || lower.endsWith(".iterate.app.localhost");
}
