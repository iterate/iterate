// context/durable-object-names.ts — the ONE place a context DO name is formatted and parsed
// (mirrors apps/os domains/durable-object-names.ts, minimal: no query props, no global host
// yet). A context is addressed by a faux URL `{projectId}.iterate{path}`:
//
//   prj_demo.iterate/                     → project root
//   prj_demo.iterate/agents/support-bot   → an agent context
//
// The projectId is always the host prefix, so a name alone says which project the context
// belongs to — the basis of isolation.

const DURABLE_OBJECT_HOST_SUFFIX = ".iterate";
// The projectId is the kv/secret prefix AND a loader-cacheKey component — a ":" (or worse) in it
// collapses the isolation wall (prj_x + key "a:b" would address the same cell as project prj_x:a
// + key "b"). Gate it at the ONE place every name is parsed.
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** A parsed DO address. `name` is its own canonical string form — parse once, carry both
 *  halves together (no separate re-stringify field at call sites). */
export type DurableObjectAddress = { projectId: string; path: string; name: string };

/** Normalize a path to leading-slash form (`""` → `"/"`, `"x"` → `"/x"`). */
export function normalizePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

/** Resolve a `cd` target against a context's own path — the one resolver both `cd` doors (the
 *  edge method and the built-in root) share. Absolute ("/agents/x") stands alone; relative
 *  ("agents/x", "../inbox", ".") joins onto `base`. `.` and `..` resolve; the root cannot be
 *  escaped ("/.." is "/"). The result is canonical: leading slash, no trailing slash but for "/". */
export function resolveContextPath(base: string, target: string): string {
  const segments: string[] = [];
  for (const seg of `${target.startsWith("/") ? "" : base}/${target}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return `/${segments.join("/")}`;
}

export const DurableObjectNameCodec = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}`. */
  stringify({ projectId, path }: { projectId: string; path: string }): string {
    return `${projectId}${DURABLE_OBJECT_HOST_SUFFIX}${normalizePath(path)}`;
  },
  /** Parses a Durable Object name. A bare name (no `.iterate`) is that project's root — what
   *  `projects.get("prj_x")` and the /cap door's `?context=prj_x` hand in. */
  parse(name: string): DurableObjectAddress {
    const i = name.indexOf(DURABLE_OBJECT_HOST_SUFFIX);
    const parts =
      i === -1
        ? { projectId: name, path: "/" }
        : {
            projectId: name.slice(0, i),
            path: normalizePath(name.slice(i + DURABLE_OBJECT_HOST_SUFFIX.length)),
          };
    if (!PROJECT_ID.test(parts.projectId))
      throw new Error(
        `invalid projectId ${JSON.stringify(parts.projectId)}: only [A-Za-z0-9_-] (a ":" would breach the kv/secret isolation wall)`,
      );
    return { ...parts, name: DurableObjectNameCodec.stringify(parts) };
  },
};

/** Canonical faux-URL form of any accepted name (bare or full), so getByName always hits the
 *  same DO. */
export function canonicalName(raw: string): string {
  return DurableObjectNameCodec.parse(raw).name;
}
