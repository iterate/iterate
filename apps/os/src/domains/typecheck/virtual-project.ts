// How a capability scope becomes a virtual TypeScript project: the platform
// type surface, one module per typed mount, ambient shims for the runtime
// globals tswasm's ES-only lib lacks, and the script under check typed as
// `(itx: Itx) => unknown` where Itx is the Project surface intersected with
// this scope's mount types. The typechecker sidecar (run-typecheck.ts)
// compiles whatever this module assembles; the split keeps "what a scope
// looks like" and "how to run tsc" independently testable.
import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { firstExportedTypeName } from "../itx/capability-type-declarations.ts";
import { declarationsByName, referencedPlatformTypeNames } from "../itx/itx-api-graph.ts";
import { itxTypesFileText } from "../itx/itx-types-text.ts";
import type { TypecheckDiagnostic } from "./run-typecheck.ts";

/** The minimal typechecker interface — `env.TYPECHECKER` satisfies it, and
 * tests satisfy it with a local tswasm compiler. */
export interface Typechecker {
  check(input: { files: Record<string, string> }): Promise<{ diagnostics: TypecheckDiagnostic[] }>;
}

const ITX_API_DECLARATIONS_BY_NAME = declarationsByName(ITX_API_DECLARATIONS);

/**
 * Ambient declarations for what scripts and the itx surface reference beyond
 * tswasm's bundled ES lib (no DOM, no workers-runtime globals). The runtime
 * names are `any` on purpose: the checker's job is catching wrong calls INTO
 * the typed surface, not modeling the whole runtime. The "platform surface
 * compiles clean" test (virtual-project.test.ts) is what keeps this list
 * sufficient.
 */
const RUNTIME_SHIMS = `// Ambient runtime shims — see virtual-project.ts.
interface SymbolConstructor {
  readonly dispose: unique symbol;
  readonly asyncDispose: unique symbol;
}
interface Disposable {
  [Symbol.dispose](): void;
}
interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}
${[
  "Response",
  "Request",
  "RequestInit",
  "RequestInfo",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "WebSocket",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
]
  // Optional type params so generic uses (ReadableStream<Uint8Array>,
  // workers-flavored Request<CfProperties>) resolve like the bare name.
  .map((name) => `type ${name}<A = any, B = any> = any;\ndeclare var ${name}: any;`)
  .join("\n")}
${[
  "console",
  "fetch",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "atob",
  "btoa",
  "crypto",
  "performance",
]
  .map((name) => `declare var ${name}: any;`)
  .join("\n")}
`;

const SHARED_FILES: Record<string, string> = {
  "itx-types.ts": itxTypesFileText,
  "runtime.d.ts": RUNTIME_SHIMS,
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      target: "es2022",
      strict: false,
      skipLibCheck: true,
    },
  }),
};

/**
 * One virtual module per typed mount. Bare platform-type references in the
 * mount's Capability Type Declaration (`export type Root = Stream;`) resolve
 * through an injected type-import. `referencedPlatformTypeNames` is the same
 * scan the docs closure walks (locally-bound names excluded in both), so
 * "readable in docs.get" and "resolvable in the checker" are one property.
 */
export function mountModuleText(types: string): string {
  const referenced = referencedPlatformTypeNames(types, ITX_API_DECLARATIONS_BY_NAME);
  const importLine =
    referenced.length > 0 ? `import type { ${referenced.join(", ")} } from "../itx-types";\n` : "";
  return importLine + types;
}

function mountFileName(dottedPath: string): string {
  return `mounts/${dottedPath}.ts`;
}

/**
 * Typecheck one mount's `types` string — the provide-time validation. Returns
 * problems as printable strings; empty means the declaration compiles against
 * the platform surface (npm `import("pkg")` references included).
 */
export async function checkCapabilityTypes(input: {
  types: string;
  typechecker: Typechecker;
}): Promise<string[]> {
  const fileName = mountFileName("provided");
  const moduleText = mountModuleText(input.types);
  const { diagnostics } = await input.typechecker.check({
    files: { ...SHARED_FILES, [fileName]: moduleText },
  });
  return formatProblems(diagnostics, {
    label: "types",
    primaryFile: fileName,
    lineOffset: moduleText === input.types ? 0 : -1, // the injected import line
  });
}

/**
 * Typecheck an `async (itx) => { … }` script against a scope's surface:
 * `itx` is `Project` intersected with the scope's mount types (typed mounts
 * by their first exported type, untyped mounts as `any`).
 */
export async function checkItxScript(input: {
  capabilities: CapabilityDescription[];
  code: string;
  typechecker: Typechecker;
}): Promise<string[]> {
  const files: Record<string, string> = { ...SHARED_FILES };
  // Each mount is its own single-path intersection term: `{ tools: { weather:
  // T } } & { tools: U }` merges correctly even when one mount's path prefixes
  // another's (both are journal-legal — dispatch is longest-prefix).
  const mountTerms: string[] = [];
  for (const capability of input.capabilities) {
    if (capability.type === "builtin") continue;
    const dottedPath = capability.path.join(".");
    const exportedName = capability.types ? firstExportedTypeName(capability.types) : undefined;
    let typeReference = "any";
    if (capability.types && exportedName) {
      files[mountFileName(dottedPath)] = mountModuleText(capability.types);
      typeReference = `import("./mounts/${dottedPath}").${exportedName}`;
    }
    // Path segments passed assertCapabilityPath (plain identifiers), so they
    // embed in a type literal unquoted.
    mountTerms.push(
      [...capability.path]
        .reverse()
        .reduce((type, segment) => `{ ${segment}: ${type} }`, typeReference),
    );
  }

  const prelude = [
    `import type { Project } from "./itx-types";`,
    `type Itx = ${["Project", ...mountTerms].join(" & ")};`,
    `const script: (itx: Itx) => unknown = (`,
  ];
  files["script.ts"] = [...prelude, input.code, ");"].join("\n");

  const { diagnostics } = await input.typechecker.check({ files });
  return formatProblems(diagnostics, {
    label: "script",
    primaryFile: "script.ts",
    // The script's first line is preceded by the prelude lines, so subtract
    // them: reported positions match the code the caller sent.
    lineOffset: -prelude.length,
  });
}

/**
 * Every error diagnostic becomes a problem string — nothing is filtered out,
 * because a broken mount module or platform-surface error silently dropped
 * would read as "the script is fine". Positions in the primary file (the
 * caller's own text) are offset back to the caller's line numbers; anything
 * else is labeled by where it lives (`mount tools.weather:2 — …`).
 */
function formatProblems(
  diagnostics: TypecheckDiagnostic[],
  options: { label: string; primaryFile: string; lineOffset: number },
): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => {
      const { fileName } = diagnostic;
      if (fileName === undefined || fileName === options.primaryFile) {
        const line =
          diagnostic.line === undefined ? undefined : diagnostic.line + options.lineOffset;
        // Lines the assembly prepended (the prelude, an injected import) map
        // below 1 — report without a position rather than lying about one.
        const position =
          line === undefined || line < 1
            ? ""
            : `:${line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`;
        return `${options.label}${position} — ${diagnostic.message} (TS${diagnostic.code})`;
      }
      const where = fileName.replace(/^mounts\//, "mount ").replace(/\.ts$/, "");
      return `${where}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`} — ${diagnostic.message} (TS${diagnostic.code})`;
    });
}
