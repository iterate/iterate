import { parseIterateRepoPkgSpec, pinIterateRepoPkgRef } from "../../pkg-pr-new.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * The template file map to seed a project repo with, re-pointed by the
 * deployment's pkg.pr.new knobs (config.ts: `iterateRepoPkgRef` pins the
 * `@<ref>` of every iterate/iterate pkg.pr.new spec — preview deploys pass
 * their PR head SHA; `iterateRepoPkgSpecOverrides` replaces named specs
 * wholesale — local dev's SDK tarball). Name-agnostic on purpose: the swap
 * recognizes dependencies by URL shape (src/pkg-pr-new.ts), so template
 * packages come and go without kernel changes. The generated file map stays
 * canonical, and the substitution happens exactly where files become a repo;
 * dynamic builds repeat it so existing repos also compile against the
 * deployment's exact packages.
 */
export function projectRepoSeedFiles(config: {
  iterateRepoPkgRef?: string;
  iterateRepoPkgSpecOverrides?: Record<string, string>;
}): Array<{ content: string; path: string }> {
  const ref = config.iterateRepoPkgRef;
  const specOverrides = config.iterateRepoPkgSpecOverrides || {};
  if (!ref && !Object.keys(specOverrides).length) {
    return PROJECT_REPO_INITIAL_FILES;
  }

  let refPinned = 0;
  const unmatchedOverrides = new Set(Object.keys(specOverrides));
  const files = PROJECT_REPO_INITIAL_FILES.map((file) => {
    if (!file.path.endsWith("package.json")) return file;
    const manifest = JSON.parse(file.content) as Record<string, Record<string, string> | undefined>;
    let changed = false;
    for (const field of PACKAGE_DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies) continue;
      for (const [name, spec] of Object.entries(dependencies)) {
        let next = spec;
        if (ref) {
          const pinned = pinIterateRepoPkgRef(spec, ref);
          if (pinned) {
            next = pinned;
            refPinned += 1;
          }
        }
        if (specOverrides[name]) {
          next = specOverrides[name];
          unmatchedOverrides.delete(name);
        }
        if (next !== spec) {
          dependencies[name] = next;
          changed = true;
        }
      }
    }
    if (!changed) return file;
    return { ...file, content: `${JSON.stringify(manifest, null, 2)}\n` };
  });

  // Fail loudly: a knob that matched nothing would make every preview e2e
  // project (or local dev build) quietly test against main's published
  // packages again.
  if (ref && refPinned === 0) {
    throw new Error(
      `iterateRepoPkgRef ${JSON.stringify(ref)} pinned nothing — no template package.json carries an iterate/iterate pkg.pr.new spec (see src/pkg-pr-new.ts).`,
    );
  }
  if (unmatchedOverrides.size > 0) {
    throw new Error(
      `iterateRepoPkgSpecOverrides for ${[...unmatchedOverrides].join(", ")} matched no template package.json dependency.`,
    );
  }
  return files;
}

/**
 * Every iterate/iterate pkg.pr.new spec the template ships (deduped). Deploy
 * pins each with the preview ref and awaits the pinned URLs before shipping.
 */
export function templateIterateRepoPkgSpecs(): string[] {
  const specs = new Set<string>();
  for (const file of PROJECT_REPO_INITIAL_FILES) {
    if (!file.path.endsWith("package.json")) continue;
    const manifest = JSON.parse(file.content) as Record<string, Record<string, string> | undefined>;
    for (const field of PACKAGE_DEPENDENCY_FIELDS) {
      for (const spec of Object.values(manifest[field] || {})) {
        if (parseIterateRepoPkgSpec(spec)) specs.add(spec);
      }
    }
  }
  if (specs.size === 0) {
    throw new Error(
      "The config repo template declares no iterate/iterate pkg.pr.new dependencies — preview pinning has nothing to pin.",
    );
  }
  return [...specs];
}
