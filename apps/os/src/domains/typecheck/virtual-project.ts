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
import {
  declarationsByName,
  referencedPlatformTypeNames,
  stripComments,
} from "../itx/itx-api-graph.ts";
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
  .map((name) => `type ${name} = any;\ndeclare var ${name}: any;`)
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
 * through an injected type-import — the same reference scan the docs closure
 * walks, so "readable in docs.get" and "resolvable in the checker" are the
 * same property.
 */
export function mountModuleText(types: string): string {
  const codeOnly = stripComments(types);
  const referenced = referencedPlatformTypeNames(types, ITX_API_DECLARATIONS_BY_NAME).filter(
    // A name the text declares itself shadows the platform one.
    (name) => !new RegExp(`\\b(?:type|interface)\\s+${name}\\b`).test(codeOnly),
  );
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
    onlyFile: fileName,
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
    onlyFile: "script.ts",
    // The script's first line is preceded by the prelude lines, so subtract
    // them: reported positions match the code the caller sent.
    lineOffset: -prelude.length,
  });
}

function formatProblems(
  diagnostics: TypecheckDiagnostic[],
  options: { label: string; onlyFile: string; lineOffset: number },
): string[] {
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.category === "error" &&
        (diagnostic.fileName === undefined || diagnostic.fileName === options.onlyFile),
    )
    .map((diagnostic) => {
      const line = diagnostic.line === undefined ? undefined : diagnostic.line + options.lineOffset;
      if (line !== undefined && line < 1) {
        // Before the caller's own text: the scope assembly itself failed
        // (say, a journaled mount whose types no longer resolve) — name the
        // real culprit instead of pinning it on the script's first line.
        return `scope — ${diagnostic.message} (TS${diagnostic.code})`;
      }
      const position =
        line === undefined
          ? ""
          : `:${line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`;
      return `${options.label}${position} — ${diagnostic.message} (TS${diagnostic.code})`;
    });
}
