// The typechecker sidecar's core, kept free of cloudflare:workers imports so
// node tests can run it against a real tswasm compiler. One job: given a
// virtual file map, resolve any npm type imports it mentions (typm over
// jsdelivr — the same acquisition the repo IDE uses), compile, and return
// diagnostics. It knows TypeScript and npm; it knows nothing about itx —
// callers assemble the project (see virtual-project.ts).
import { acquireTypes } from "@iterate-com/typm";
import { importedPackageNames, importSpecifiersIn } from "../itx/itx-api-graph.ts";
import { openApiCapabilityTypeDeclaration } from "../itx/capability-type-declarations.ts";
import { listOpenApiOperations } from "../itx/openapi-types.ts";

/** One compiler diagnostic — tswasm's own shape (aliased so nothing drifts). */
export type TypecheckDiagnostic = import("tswasm").Diagnostic;

/** What a check returns: diagnostics plus acquisition notes (npm budget
 * trips, download failures) — without the notes, a budget-tripped package
 * reads as a plain "Cannot find module" typo. */
export interface TypecheckResult {
  diagnostics: TypecheckDiagnostic[];
  notes: string[];
}

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
const packageTypesCache = new Map<
  string,
  Promise<{ files: Record<string, string>; warnings: string[] }>
>();

/**
 * Compile a virtual project and return its diagnostics. Bare import
 * specifiers in the CODE of `files` (`import("@slack/web-api")`,
 * `from "zod"`) get their `.d.ts` surface acquired from npm and placed under
 * `/node_modules` first, so vendor-typed code resolves like it would in a
 * real project. Nothing here throws for a caller-shaped reason: acquisition
 * failures degrade to "cannot find module" diagnostics plus a note, and a
 * compiler crash (a type-compute bomb can exhaust the isolate) comes back as
 * an error diagnostic rather than an infra exception.
 */
export async function runTypecheck(input: {
  compiler: CompileFn;
  fetchImpl: (url: string) => Promise<Response>;
  files: Record<string, string>;
}): Promise<TypecheckResult> {
  const files = { ...input.files };
  const notes: string[] = [];
  for (const packageName of npmPackagesMentioned(input.files)) {
    const cached = packageTypesCache.get(packageName);
    const acquisition =
      cached ??
      acquireTypes({
        // "latest" is the npm dist-tag; a bare "*" range resolves to the
        // highest semver INCLUDING prereleases (typescript@* acquired the
        // 7.0 native preview), which is never what a reader means.
        packageJson: JSON.stringify({ dependencies: { [packageName]: "latest" } }),
        fetch: input.fetchImpl,
        log: () => {},
        limits: TYPM_LIMITS,
      }).then((result) => ({ files: result.files, warnings: result.warnings }));
    if (!cached) packageTypesCache.set(packageName, acquisition);
    try {
      const acquired = await acquisition;
      Object.assign(files, acquired.files);
      notes.push(...acquired.warnings.map((warning) => `npm ${packageName}: ${warning}`));
    } catch (error) {
      // Evict only if a concurrent caller has not already replaced the entry.
      if (packageTypesCache.get(packageName) === acquisition) {
        packageTypesCache.delete(packageName);
      }
      notes.push(`npm ${packageName}: type acquisition failed (${String(error)})`);
    }
  }
  const openApi = await materializeOpenApiModules(input.files, input.fetchImpl);
  notes.push(...openApi.notes);
  if (openApi.moduleText !== "") files["openapi-modules.d.ts"] = openApi.moduleText;
  try {
    return { diagnostics: input.compiler.compile({ files }).diagnostics, notes };
  } catch (error) {
    return {
      diagnostics: [
        {
          category: "error",
          code: 0,
          message:
            `type checking crashed (${String(error).slice(0, 200)}) — ` +
            `the types are probably too complex to check; simplify them.`,
        },
      ],
      notes,
    };
  }
}

/** Npm packages imported anywhere in the file map's CODE (the shared
 * literal-after-import/from scan — see importedPackageNames). Already-
 * acquired /node_modules files never re-scan. */
export function npmPackagesMentioned(files: Record<string, string>): string[] {
  const packages = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("/node_modules/")) continue;
    for (const name of importedPackageNames(text)) packages.add(name);
  }
  return [...packages];
}

/** Generated OpenAPI declarations, cached per spec URL for the isolate's
 * lifetime like npm acquisitions. Specs are re-fetched by fresh isolates
 * (spec URLs are mutable, so they are deliberately NOT in the Cache API). */
const openApiModuleCache = new Map<string, Promise<string>>();

/** Byte ceiling on a fetched spec (Stripe's is ~7MB and fits). */
const MAX_SPEC_BYTES = 10 * 1024 * 1024;

/**
 * `import("openapi:<specUrl>")` specifiers resolve here: fetch the spec,
 * generate the full Capability declaration IN MEMORY, and expose it as an
 * ambient module — the journal and every reader carry only the one-line
 * reference (openApiCapabilityTypeReference); the checker alone sees the
 * schemas. A spec that cannot be fetched or parsed leaves its module
 * undeclared (a "Cannot find module" diagnostic) plus a note saying why.
 */
async function materializeOpenApiModules(
  files: Record<string, string>,
  fetchImpl: (url: string) => Promise<Response>,
): Promise<{ moduleText: string; notes: string[] }> {
  const specifiers = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("/node_modules/")) continue;
    for (const specifier of importSpecifiersIn(text)) {
      if (specifier.startsWith("openapi:")) specifiers.add(specifier);
    }
  }
  const declarations: string[] = [];
  const notes: string[] = [];
  for (const specifier of specifiers) {
    const specUrl = specifier.slice("openapi:".length);
    const cached = openApiModuleCache.get(specifier);
    const generation =
      cached ??
      (async () => {
        const response = await fetchImpl(specUrl);
        if (!response.ok) throw new Error(`spec fetch returned ${response.status}`);
        const spec = JSON.parse(await boundedBody(response, MAX_SPEC_BYTES)) as Record<
          string,
          unknown
        >;
        const declaration = openApiCapabilityTypeDeclaration(listOpenApiOperations(spec), spec);
        // Ambient modules match arbitrary specifier strings; exports inside
        // keep their names, so import("openapi:…").Capability resolves.
        return `declare module ${JSON.stringify(specifier)} {\n${declaration}\n}`;
      })();
    if (!cached) openApiModuleCache.set(specifier, generation);
    try {
      declarations.push(await generation);
    } catch (error) {
      if (openApiModuleCache.get(specifier) === generation) {
        openApiModuleCache.delete(specifier);
      }
      notes.push(`openapi ${specUrl}: type generation failed (${String(error)})`);
    }
  }
  return { moduleText: declarations.join("\n\n"), notes };
}

/** Read a response body, aborting once it exceeds `maxBytes` — the cap must
 * bind DURING download (same order of budget as the npm lane's TYPM_LIMITS);
 * checking after `.text()` would let an oversized spec exhaust the isolate
 * before the compile's crash guard ever runs. */
async function boundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text(); // test fakes without streams
    if (text.length > maxBytes) throw new Error(`spec exceeds ${maxBytes} bytes`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`spec exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
