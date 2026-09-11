export interface IngressEnv {
  PUBLIC_ORIGIN: string;
  PROJECT_HOSTNAME_BASE: string;
  PROJECTS: Record<string, string>;
  CUSTOM_HOSTNAMES: Record<string, string>;
}

/** Deployment-owned names, not authority supplied by an HTTP caller. No directory I/O. */
export function resolveProjectHost(url: URL, env: IngressEnv) {
  const dashboard = new URL(env.PUBLIC_ORIGIN);
  const local = dashboard.hostname === "localhost";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const base = local ? "localhost" : env.PROJECT_HOSTNAME_BASE;
  if (host.endsWith(`.${base}`)) {
    const label = host.slice(0, -base.length - 1);
    if (!label.includes(".")) {
      // As in OS, a complete slug wins before interpreting an app prefix.
      if (Object.hasOwn(env.PROJECTS, label)) return { projectId: env.PROJECTS[label]!, app: null };
      const separator = label.indexOf("--");
      const slug = label.slice(separator + 2);
      if (separator > 0 && Object.hasOwn(env.PROJECTS, slug))
        return { projectId: env.PROJECTS[slug]!, app: label.slice(0, separator) };
    }
  }
  // Exact custom domains win over their one-label subdomains.
  if (Object.hasOwn(env.CUSTOM_HOSTNAMES, host))
    return { projectId: env.CUSTOM_HOSTNAMES[host]!, app: null };
  const dot = host.indexOf(".");
  const domain = host.slice(dot + 1);
  if (dot > 0 && Object.hasOwn(env.CUSTOM_HOSTNAMES, domain))
    return { projectId: env.CUSTOM_HOSTNAMES[domain]!, app: host.slice(0, dot) };
  return null;
}
