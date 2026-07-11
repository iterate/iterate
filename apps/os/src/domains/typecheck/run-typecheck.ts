// The typechecker sidecar's core, kept free of cloudflare:workers imports so
// node tests can run it against a real tswasm compiler. One job: given a
// virtual file map, resolve any npm type imports it mentions (typm over
// jsdelivr — the same acquisition the repo IDE uses), compile, and return
// diagnostics. It knows TypeScript and npm; it knows nothing about itx —
// callers assemble the project (see virtual-project.ts).
import { acquireTypes } from "@iterate-com/typm";
import { stripComments } from "../itx/itx-api-graph.ts";

/** One compiler diagnostic — tswasm's own shape (aliased so nothing drifts). */
export type TypecheckDiagnostic = import("tswasm").Diagnostic;

/** The slice of a tswasm `Compiler` this module needs. */
export interface CompileFn {
  compile(request: { files: Record<string, string> }): {
    diagnostics: TypecheckDiagnostic[];
  };
}

/** Download budget for npm type acquisition — enough for a vendor SDK and its
 * transitive @types, small enough that a pathological dependency tree fails
 * fast instead of stalling a check. */
const TYPM_LIMITS = { maxPackages: 40, maxTotalBytes: 20 * 1024 * 1024 };

/** `.d.ts` maps per npm package, cached for the isolate's lifetime — package
 * type surfaces are immutable enough for an advisory checker. */
const packageTypesCache = new Map<string, Promise<Record<string, string>>>();

/**
 * Compile a virtual project and return its diagnostics. Bare import
 * specifiers in the CODE of `files` (`import("@slack/web-api")`,
 * `from "zod"`) get their `.d.ts` surface acquired from npm and placed under
 * `/node_modules` first, so vendor-typed code resolves like it would in a
 * real project. Acquisition failures degrade to "cannot find module"
 * diagnostics rather than throwing — this is a checker, not an installer.
 */
export async function runTypecheck(input: {
  compiler: CompileFn;
  fetchImpl: (url: string) => Promise<Response>;
  files: Record<string, string>;
}): Promise<{ diagnostics: TypecheckDiagnostic[] }> {
  const files = { ...input.files };
  for (const packageName of npmPackagesMentioned(input.files)) {
    const cached = packageTypesCache.get(packageName);
    const acquisition =
      cached ??
      acquireTypes({
        packageJson: JSON.stringify({ dependencies: { [packageName]: "*" } }),
        fetch: input.fetchImpl,
        log: () => {},
        limits: TYPM_LIMITS,
      }).then((result) => result.files);
    if (!cached) packageTypesCache.set(packageName, acquisition);
    try {
      Object.assign(files, await acquisition);
    } catch {
      packageTypesCache.delete(packageName);
    }
  }
  return { diagnostics: input.compiler.compile({ files }).diagnostics };
}

/**
 * Npm package names imported in the file map's CODE — comments are stripped
 * first, because the platform surface's own docstrings mention npm imports
 * as examples and must never trigger acquisition. Bare specifiers only,
 * subpaths collapsed to the package (`@slack/web-api/dist/x` →
 * `@slack/web-api`).
 */
export function npmPackagesMentioned(files: Record<string, string>): string[] {
  const packages = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("/node_modules/")) continue;
    for (const match of stripComments(text).matchAll(
      /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:")) continue;
      const segments = specifier.split("/");
      packages.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!);
    }
  }
  return [...packages];
}
