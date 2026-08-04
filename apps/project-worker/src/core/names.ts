// core/names.ts — the ONE place a context DO name is formatted/parsed (target-core §3 / D21/D25). A context is
// addressed by a faux URL `{projectId}.iterate{path}` (mirrors apps/os DurableObjectNameCodec, minimal):
//   prj_demo.iterate/                     → project root
//   prj_demo.iterate/agents/support-bot   → an agent context
// The projectId is always the host prefix, so a name alone says which project the context belongs to — the
// basis of isolation. A bare name (no `.iterate`) is treated as that project's root (a convenience).

const SUFFIX = ".iterate";

export type ContextName = { projectId: string; path: string };

/** Normalize a path to leading-slash form (`""` → `"/"`, `"x"` → `"/x"`). */
export function normalizePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

export function stringifyName({ projectId, path }: ContextName): string {
  return `${projectId}${SUFFIX}${normalizePath(path)}`;
}

export function parseName(name: string): ContextName {
  const i = name.indexOf(SUFFIX);
  if (i === -1) return { projectId: name, path: "/" }; // bare name → the project root
  return { projectId: name.slice(0, i), path: normalizePath(name.slice(i + SUFFIX.length)) };
}

/** Canonical faux-URL form of any accepted name (bare or full), so getByName always hits the same DO. */
export function canonicalName(raw: string): string {
  return stringifyName(parseName(raw));
}

/** The enclosing path a context falls back to; `null` at the root (which falls back to the shell instead). */
export function parentPath(path: string): string | null {
  const p = normalizePath(path);
  if (p === "/") return null;
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
