import { projectUrlOf, type IngressRouting } from "iterate/project-ingress";

/** `value` as an http(s) origin, or null. What the issuer's `info()` reports — its platform and MCP
 *  origins — becomes an href or a copyable command only once parsed: a value that is not a URL, or
 *  not http(s) (`javascript:`), goes nowhere. */
export function httpOriginOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}

/** A project's own site under this deployment's ingress (`projectUrlOf`) — null when the deployment
 *  serves no project hosts. The slug, never the id: the id is how a project is addressed, the slug is
 *  its label in a hostname or a path. The platform's origin is parsed first: it comes from the
 *  issuer's `info()`, and only an http(s) origin may become an href. */
export function projectHostOf(
  info: { platformOrigin: string; ingressRouting: IngressRouting },
  slug: string,
): string | null {
  const origin = httpOriginOf(info.platformOrigin);
  return origin ? projectUrlOf(info.ingressRouting, origin, { project: slug })?.href || null : null;
}
