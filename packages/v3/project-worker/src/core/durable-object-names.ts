// core/durable-object-names.ts — the ONE place a context DO name is formatted and parsed
// (mirrors apps/os domains/durable-object-names.ts, minimal: no query props, no global host
// yet). A context is addressed by a faux URL `{projectId}.iterate{path}`:
//
//   prj_demo.iterate/                     → project root
//   prj_demo.iterate/agents/support-bot   → an agent context
//
// The projectId is always the host prefix, so a name alone says which project the context
// belongs to — the basis of isolation.

const DURABLE_OBJECT_HOST_SUFFIX = ".iterate";

/** A parsed DO address. `name` is its own canonical string form — parse once, carry both
 *  halves together (no separate re-stringify field at call sites). */
export type DurableObjectAddress = { projectId: string; path: string; name: string };

/** Normalize a path to leading-slash form (`""` → `"/"`, `"x"` → `"/x"`). */
export function normalizePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

export const DurableObjectNameCodec = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}`. */
  stringify({ projectId, path }: { projectId: string; path: string }): string {
    return `${projectId}${DURABLE_OBJECT_HOST_SUFFIX}${normalizePath(path)}`;
  },
  /** Parses a Durable Object name. A bare name (no `.iterate`) is that project's root — the
   *  edge's convenience for `?ctx=prj_x`. */
  parse(name: string): DurableObjectAddress {
    const i = name.indexOf(DURABLE_OBJECT_HOST_SUFFIX);
    const parts =
      i === -1
        ? { projectId: name, path: "/" }
        : {
            projectId: name.slice(0, i),
            path: normalizePath(name.slice(i + DURABLE_OBJECT_HOST_SUFFIX.length)),
          };
    return { ...parts, name: DurableObjectNameCodec.stringify(parts) };
  },
};

/** Canonical faux-URL form of any accepted name (bare or full), so getByName always hits the
 *  same DO. */
export function canonicalName(raw: string): string {
  return DurableObjectNameCodec.parse(raw).name;
}
