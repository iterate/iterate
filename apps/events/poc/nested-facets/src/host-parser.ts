// Shared host parsing — used by worker, Project DO, and AppRunner.

export const PLATFORM_SUFFIX = ".iterate-dev-jonas.app";
export const PLATFORM_BARE = "iterate-dev-jonas.app";

export type Parsed =
  | { level: "admin" }
  | { level: "project"; project: string }
  | { level: "app"; project: string; app: string };

export async function parseHost(host: string, db: D1Database): Promise<Parsed | null> {
  if (host === PLATFORM_BARE || host === `www.${PLATFORM_BARE}` || host.endsWith(".workers.dev")) {
    return { level: "admin" };
  }
  if (host.endsWith(PLATFORM_SUFFIX)) {
    const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
    const dot = prefix.indexOf(".");
    if (dot === -1) return { level: "project", project: prefix };
    return { level: "app", app: prefix.slice(0, dot), project: prefix.slice(dot + 1) };
  }
  const projects = await db
    .prepare("SELECT slug, canonical_hostname FROM projects WHERE canonical_hostname IS NOT NULL")
    .all<{ slug: string; canonical_hostname: string }>();
  for (const p of projects.results) {
    const domain = p.canonical_hostname;
    if (host === domain) return { level: "project", project: p.slug };
    if (host.endsWith(`.${domain}`)) {
      return { level: "app", app: host.slice(0, -(domain.length + 1)), project: p.slug };
    }
  }
  return null;
}
