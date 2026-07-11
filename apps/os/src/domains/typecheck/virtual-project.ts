// How a capability scope becomes a virtual TypeScript project: the platform
// type surface, one module per typed mount, ambient shims for the runtime
// globals tswasm's ES-only lib lacks, and the script under check typed as
// `(itx: Itx) => unknown` where Itx is the Project surface intersected with
// this scope's mount tree. The typechecker sidecar (run-typecheck.ts)
// compiles whatever this module assembles; the split keeps "what a scope
// looks like" and "how to run tsc" independently testable.
import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { firstExportedTypeName } from "../itx/capability-type-declarations.ts";
import { declarationsByName, referencedPlatformTypeNames } from "../itx/itx-api-graph.ts";
import type { TypecheckDiagnostic } from "./run-typecheck.ts";

/** The minimal typechecker interface — `env.TYPECHECKER` satisfies it, and
 * tests satisfy it with a local tswasm compiler. */
export interface Typechecker {
  check(input: { files: Record<string, string> }): Promise<{ diagnostics: TypecheckDiagnostic[] }>;
}

const ITX_API_DECLARATIONS_BY_NAME = declarationsByName(ITX_API_DECLARATIONS);

/** The platform surface as one virtual module (same join the browser REPL
 * uses — see components/itx-repl-types.ts). */
const ITX_TYPES_FILE_TEXT = ITX_API_DECLARATIONS.map((declaration) => declaration.sourceText).join(
  "\n\n",
);

/**
 * Ambient declarations for what scripts and the itx surface reference beyond
 * tswasm's bundled ES lib (no DOM, no workers-runtime globals). Everything is
 * `any` on purpose: the checker's job is catching wrong calls INTO the typed
 * surface, not modeling the whole runtime. The "platform surface compiles
 * clean" test (virtual-project.test.ts) is what keeps this list sufficient.
 */
const RUNTIME_SHIMS = `// Ambient runtime globals (all any — see virtual-project.ts).
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
  "itx-types.ts": ITX_TYPES_FILE_TEXT,
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
  const referenced = referencedPlatformTypeNames(types, ITX_API_DECLARATIONS_BY_NAME).filter(
    // A name the text declares itself shadows the platform one.
    (name) => !new RegExp(`\\b(?:type|interface)\\s+${name}\\b`).test(types),
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
  const { diagnostics } = await input.typechecker.check({
    files: { ...SHARED_FILES, [fileName]: mountModuleText(input.types) },
  });
  // The injected import is one line, so mount-text line N reports as N+1
  // when an import was added — close enough for a one-string declaration;
  // the message is what matters.
  return formatProblems(diagnostics, { label: "types", onlyFile: fileName });
}

/**
 * Typecheck an `async (itx) => { … }` script against a scope's surface:
 * `itx` is `Project` intersected with the scope's mount tree (typed mounts
 * by their first exported type, untyped mounts as `any`).
 */
export async function checkItxScript(input: {
  capabilities: CapabilityDescription[];
  code: string;
  typechecker: Typechecker;
}): Promise<string[]> {
  const files: Record<string, string> = { ...SHARED_FILES };
  const mounts: Array<{ path: string[]; typeReference: string }> = [];
  for (const capability of input.capabilities) {
    if (capability.type === "builtin") continue;
    const dottedPath = capability.path.join(".");
    const exportedName = capability.types ? firstExportedTypeName(capability.types) : undefined;
    if (capability.types && exportedName) {
      files[mountFileName(dottedPath)] = mountModuleText(capability.types);
      mounts.push({
        path: capability.path,
        typeReference: `import("./mounts/${dottedPath}").${exportedName}`,
      });
    } else {
      mounts.push({ path: capability.path, typeReference: "any" });
    }
  }

  const prelude = [
    `import type { Project } from "./itx-types";`,
    `type Itx = Project & ${mountsTreeText(mounts)};`,
    `const script: (itx: Itx) => unknown = (`,
  ];
  files["script.ts"] = [...prelude, input.code, ");", "void script;", "export {};"].join("\n");

  const { diagnostics } = await input.typechecker.check({ files });
  return formatProblems(diagnostics, {
    label: "script",
    onlyFile: "script.ts",
    // The script's first line is preceded by the prelude lines, so subtract
    // them: reported positions match the code the caller sent.
    lineOffset: -prelude.length,
  });
}

/** The mount tree as a type literal: `{ tools: { weather: T }; pets: U }`. */
function mountsTreeText(mounts: Array<{ path: string[]; typeReference: string }>): string {
  if (mounts.length === 0) return "{}";
  type Tree = { [segment: string]: Tree | string };
  const root: Tree = {};
  for (const mount of mounts) {
    let node = root;
    for (const segment of mount.path.slice(0, -1)) {
      const next = node[segment];
      node = typeof next === "object" ? next : (node[segment] = {});
    }
    node[mount.path.at(-1)!] ??= mount.typeReference;
  }
  const render = (tree: Tree): string =>
    `{ ${Object.entries(tree)
      .map(([segment, value]) => {
        const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? segment : JSON.stringify(segment);
        return `${name}: ${typeof value === "string" ? value : render(value)}`;
      })
      .join("; ")} }`;
  return render(root);
}

function formatProblems(
  diagnostics: TypecheckDiagnostic[],
  options: { label: string; onlyFile: string; lineOffset?: number },
): string[] {
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.category === "error" &&
        (diagnostic.fileName === undefined || diagnostic.fileName === options.onlyFile),
    )
    .map((diagnostic) => {
      const line =
        diagnostic.line === undefined
          ? undefined
          : Math.max(1, diagnostic.line + (options.lineOffset ?? 0));
      const position =
        line === undefined
          ? ""
          : `:${line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`;
      return `${options.label}${position} — ${diagnostic.message} (TS${diagnostic.code})`;
    });
}
