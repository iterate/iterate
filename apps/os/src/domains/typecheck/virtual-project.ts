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
import type { TypecheckDiagnostic, TypecheckResult } from "./run-typecheck.ts";

/** The minimal typechecker interface — `env.TYPECHECKER` satisfies it, and
 * tests satisfy it with a local tswasm compiler. */
export interface Typechecker {
  check(input: { files: Record<string, string> }): Promise<TypecheckResult>;
}

/** Scripts bigger than this get a clean problem instead of a compile — a
 * multi-megabyte "script" is never a real check, only a CPU burn. */
const MAX_SCRIPT_CHARS = 200_000;

/** What the agent runtime's extractor accepts — keep in lockstep with
 * extractAsyncJsSnippet (agent-processor-implementation.ts): `async (…)`,
 * `async function`, or the parenthesized `(async (…)` form. The checker
 * enforces the same rule, or a pre-flighted green script would bounce at
 * run time. */
const RUNTIME_SCRIPT_SHAPE = /^(?:async\s*(?:function|\()|\(async\s*\()/;

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
  // nodejs_compat globals — dynamic workers run with the flag, so scripts
  // legitimately reach these; unshimmed they would fail the EXECUTION gate
  // (checkItxScriptForExecution) for code that runs fine.
  "Buffer",
  "Event",
  "EventTarget",
  "DOMException",
  "MessageChannel",
  "MessagePort",
  "WebSocketPair",
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
  // nodejs_compat / workerd value-only globals (see the typed list above).
  "process",
  "navigator",
  "caches",
  "scheduler",
  "self",
  "reportError",
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
  if (input.types.length > MAX_SCRIPT_CHARS) {
    return [
      `types — ${input.types.length} characters is over the ${MAX_SCRIPT_CHARS}-character check limit.`,
    ];
  }
  const fileName = mountFileName("provided");
  const moduleText = mountModuleText(input.types);
  const { diagnostics, notes } = await input.typechecker.check({
    files: { ...SHARED_FILES, [fileName]: moduleText },
  });
  const problems = formatProblems(diagnostics, {
    label: "types",
    primaryFile: fileName,
    lineOffset: moduleText === input.types ? 0 : -1, // the injected import line
  });
  // A declaration that compiles but exports no top-level type is an authoring
  // mistake, not a typed mount: the first exported type IS the contract, and
  // without one the mount would silently degrade to `any` (or worse — the
  // namespace-nested case used to poison the whole scope's typecheck).
  if (problems.length === 0 && firstExportedTypeName(input.types) === undefined) {
    problems.push(
      "types — compiles but exports no top-level type/interface/class/enum; " +
        "the FIRST exported declaration names the mount's type.",
    );
  }
  // Notes are CONTEXT for failures (a budget-tripped npm package reads as a
  // plain typo without them), never verdicts: typm warns on perfectly
  // successful acquisitions, and a warning must not fail a compiling mount.
  return problems.length > 0 ? [...problems, ...notes] : [];
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
  if (typeof input.code !== "string") {
    return [`script — code must be a string (got ${typeof input.code}).`];
  }
  if (input.code.length > MAX_SCRIPT_CHARS) {
    return [
      `script — ${input.code.length} characters is over the ${MAX_SCRIPT_CHARS}-character check limit; split the script.`,
    ];
  }
  if (!RUNTIME_SCRIPT_SHAPE.test(input.code.trim())) {
    return [
      "script — the runtime only accepts a block that starts with `async (` / " +
        "`async function` (or the same wrapped in parens); remove anything " +
        "before it, comments included.",
    ];
  }
  const project = assembleScriptProject(input.capabilities, input.code);
  const { diagnostics, notes } = await input.typechecker.check({ files: project.files });
  const problems = formatProblems(diagnostics, {
    label: "script",
    primaryFile: "script.ts",
    // The script's first line is preceded by the prelude lines, so subtract
    // them: reported positions match the code the caller sent.
    lineOffset: -project.preludeLineCount,
  });
  // Notes only contextualize failures — see checkCapabilityTypes.
  return problems.length > 0 ? [...problems, ...notes] : [];
}

/** The virtual project for one script check — shared by the advisory door
 * (checkItxScript) and the execution gate (checkItxScriptForExecution). */
function assembleScriptProject(
  capabilities: CapabilityDescription[],
  code: string,
): { files: Record<string, string>; preludeLineCount: number } {
  const files: Record<string, string> = { ...SHARED_FILES };
  // Each mount is its own single-path intersection term: `{ tools: { weather:
  // T } } & { tools: U }` merges correctly even when one mount's path prefixes
  // another's (both are journal-legal — dispatch is longest-prefix).
  const mountTerms: string[] = [];
  for (const capability of capabilities) {
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
    // Rest params so a script declaring extra parameters (the runtime calls
    // fn(itx), extras just stay undefined) stays assignable.
    `const script: (itx: Itx, ...rest: any[]) => unknown = (`,
  ];
  files["script.ts"] = [...prelude, code, ");"].join("\n");
  return { files, preludeLineCount: prelude.length };
}

/**
 * How the execution gate reads a script check: `problems` blocks the run;
 * `clean` and `unchecked` both let it proceed. Distinct from checkItxScript
 * (the advisory docs door), which reports everything — the gate blocks only
 * on errors it can PROVE against surfaces it can see, because a script must
 * never be stopped by what the checker doesn't know.
 */
export type ScriptExecutionCheck =
  | { verdict: "clean" }
  | { verdict: "problems"; problems: string[] }
  | { verdict: "unchecked"; reason: string };

/** Wall-clock budget for the pre-execution check. Generous enough for a cold
 * sidecar isolate (wasm instantiation + first compile) plus npm type
 * acquisition; past it the script runs unchecked rather than stall. */
const EXECUTION_CHECK_DEADLINE_MS = 10_000;

/** Unresolved-module diagnostics never block execution: "Cannot find module"
 * conflates a typo'd specifier with a failed/absent type acquisition, and the
 * runtime's own loader error is the truthful verdict for the former. */
const UNRESOLVED_MODULE_CODES = new Set([
  2307, // Cannot find module 'X'
  2792, // Cannot find module 'X'. Did you mean to set moduleResolution…
  7016, // Could not find a declaration file for module 'X'
]);

/**
 * The pre-execution typecheck for a `script-execution-requested` block:
 * everything checkItxScript checks, read through the permissive-by-default
 * policy above. Blocking requires an error diagnostic in the script's OWN
 * code (`script.ts`) that is not an unresolved module. Everything the checker
 * cannot vouch for runs unchecked instead: shapes the agent extractor never
 * produces (raw runScript callers send plain function expressions), oversized
 * scripts, broken mount declarations (stale journals must not veto unrelated
 * scripts), compiler crashes, an unreachable typechecker, and the deadline.
 * Never throws.
 */
export async function checkItxScriptForExecution(input: {
  capabilities: CapabilityDescription[];
  code: string;
  typechecker: Typechecker;
  deadlineMs?: number;
}): Promise<ScriptExecutionCheck> {
  if (typeof input.code !== "string") {
    return { verdict: "unchecked", reason: `code is ${typeof input.code}, not a string` };
  }
  if (input.code.length > MAX_SCRIPT_CHARS) {
    return {
      verdict: "unchecked",
      reason: `script is ${input.code.length} characters, over the check limit`,
    };
  }
  if (!RUNTIME_SCRIPT_SHAPE.test(input.code.trim())) {
    return { verdict: "unchecked", reason: "not the async block shape the checker models" };
  }
  const project = assembleScriptProject(input.capabilities, input.code);
  let checked: TypecheckResult;
  try {
    checked = await withDeadline(
      input.typechecker.check({ files: project.files }),
      input.deadlineMs ?? EXECUTION_CHECK_DEADLINE_MS,
    );
  } catch (error) {
    return { verdict: "unchecked", reason: `typechecker unavailable (${String(error)})` };
  }
  // runTypecheck's crash guard reports a compiler crash as a code-0 error
  // diagnostic — a check that DIDN'T HAPPEN, not a verdict on the script.
  if (checked.diagnostics.some((diagnostic) => diagnostic.code === 0)) {
    return { verdict: "unchecked", reason: "type checking crashed" };
  }
  const blocking = checked.diagnostics.filter(
    (diagnostic) =>
      diagnostic.category === "error" &&
      diagnostic.fileName === "script.ts" &&
      !UNRESOLVED_MODULE_CODES.has(diagnostic.code),
  );
  if (blocking.length === 0) return { verdict: "clean" };
  const problems = formatProblems(blocking, {
    label: "script",
    primaryFile: "script.ts",
    lineOffset: -project.preludeLineCount,
  });
  return { verdict: "problems", problems: [...problems, ...checked.notes] };
}

/** Race a check against its wall-clock budget. Promise.race keeps a handler
 * on the losing check, so a late rejection never surfaces as unhandled. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`typecheck exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
