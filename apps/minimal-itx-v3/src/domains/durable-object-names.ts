// durable-object-names.ts — the ONE place a Durable Object name is formatted and
// parsed. Every domain Durable Object name is `{projectId}:{path}`: a single,
// common prefixing scheme (mirrors apps/os/src/domains/durable-object-names.ts).
// Because the projectId is always the prefix, a name alone tells you which
// project the object belongs to — that is the whole basis of the access model.
//
// `__null__` is the platform projectId: streams that belong to no project
// (integration webhooks, the project catalog, …). It is NOT a connectable
// context. The only door to `__null__` objects is an authenticated ITX with
// project-creation/admin authority. Everywhere else it is an ordinary projectId
// string.

export const PLATFORM_PROJECT_ID = "__null__";

export type DurableObjectNameParts = { projectId: string; path: string };

function normalizePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

export function formatDurableObjectName({ projectId, path }: DurableObjectNameParts): string {
  if (projectId === "" || projectId.includes(":")) {
    throw new Error(`Durable Object projectId must be non-empty and ":"-free, got "${projectId}".`);
  }
  return `${projectId}:${normalizePath(path)}`;
}

export function parseDurableObjectName(name: string): DurableObjectNameParts {
  const colon = name.indexOf(":");
  if (colon <= 0 || name[colon + 1] !== "/") {
    throw new Error(`Durable Object name must be "{projectId}:{path}", got "${name}".`);
  }
  return { projectId: name.slice(0, colon), path: normalizePath(name.slice(colon + 1)) };
}
