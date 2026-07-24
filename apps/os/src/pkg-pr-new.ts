/**
 * Parsing and ref-pinning for this repo's pkg.pr.new dependency specs.
 *
 * BAKED-IN ASSUMPTION: this repo publishes its first-party packages through
 * pkg.pr.new in a uniform way (.github/workflows/pkg-pr-new.yml), and always
 * will. Every kernel feature that re-points those packages — preview pinning,
 * seeded-template substitution, dynamic-build rewrites, deploy preflight —
 * recognizes dependencies purely by these URL shapes, never by package name.
 * If we ever stop using pkg.pr.new this way, change this module then.
 *
 * Recognized shapes (both verified resolving):
 *
 *   https://pkg.pr.new/iterate/iterate/<name>@<ref>   e.g. iterate, @iterate-com/tasks
 *   https://pkg.pr.new/iterate/iterate@<ref>          compact form of the repo-named package
 *
 * `<ref>` is a branch (`main`), a 40-char commit SHA, or a PR number. Scoped
 * names contain their own `@`, so the ref is split on the LAST `@`.
 */

const ITERATE_REPO_SPEC_PREFIX = "https://pkg.pr.new/iterate/iterate";

/**
 * Parse a dependency spec as an iterate/iterate pkg.pr.new URL. Returns the
 * published package name and the ref, or null when the spec is anything else
 * (registry ranges, tarball URLs, other repos' pkg.pr.new URLs, ...).
 */
export function parseIterateRepoPkgSpec(spec: string): { name: string; ref: string } | null {
  if (!spec.startsWith(ITERATE_REPO_SPEC_PREFIX)) return null;
  const rest = spec.slice(ITERATE_REPO_SPEC_PREFIX.length);

  // Compact form: the package is named after the repo.
  if (rest.startsWith("@")) {
    const ref = rest.slice(1);
    return ref ? { name: "iterate", ref } : null;
  }

  if (!rest.startsWith("/")) return null;
  const refAt = rest.lastIndexOf("@");
  const name = rest.slice(1, refAt);
  const ref = rest.slice(refAt + 1);
  // A scoped name's own `@` is at index 1, so a real ref separator is later.
  if (refAt < 2 || !name || !ref) return null;
  return { name, ref };
}

/**
 * Swap the `@<ref>` of an iterate/iterate pkg.pr.new spec for `ref`, keeping
 * the package (and URL form) as-is. Null when the spec is not one of ours —
 * callers leave those dependencies untouched.
 */
export function pinIterateRepoPkgRef(spec: string, ref: string): string | null {
  const parsed = parseIterateRepoPkgSpec(spec);
  if (parsed === null) return null;
  return spec.slice(0, spec.length - parsed.ref.length) + ref;
}

/**
 * Parse the raw `APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES` env value (a
 * JSON map of dependency name → replacement spec — local dev's SDK-tarball
 * lockstep, see apps/os/scripts/lib/dev-sdk-tarball.ts). Undefined when the
 * knob is unset; malformed JSON throws rather than silently unpinning.
 */
export function parseIterateRepoPkgSpecOverridesEnv(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES must be a JSON object, got ${raw}`);
  }
  const overrides: Record<string, string> = {};
  for (const [name, spec] of Object.entries(parsed)) {
    if (typeof spec !== "string" || !spec.trim()) {
      throw new Error(
        `APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES[${JSON.stringify(name)}] must be a dependency spec string`,
      );
    }
    overrides[name] = spec;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
