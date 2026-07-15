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
  check(input: {
    files: Record<string, string>;
    /** Virtual path whose emitted JavaScript comes back as result.js. */
    entrypoint?: string;
  }): Promise<TypecheckResult>;
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
// The published SDK and docs expose the exact import("octokit").Octokit type.
// Loading that package's large transitive declaration graph into every
// unrelated in-Worker script check exceeds the Worker memory limit, so this
// compiler-only structural view preserves Octokit's RPC-safe entry points.
type IterateTypecheckOctokit = {
  rest: Record<string, Record<string, (input?: any) => Promise<any>>>;
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  request<T = unknown>(route: string, parameters?: Record<string, unknown>): Promise<T>;
  paginate<T = unknown>(route: string, parameters?: Record<string, unknown>): Promise<T[]>;
};
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
  // legitimately reach these; unshimmed, code that runs fine reports errors
  // to every reader (the docs door, the execution gate's near-miss check).
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

const TYPECHECKER_ITX_TYPES = itxTypesFileText.replace(
  'import("octokit").Octokit',
  "IterateTypecheckOctokit",
);
if (TYPECHECKER_ITX_TYPES === itxTypesFileText) {
  throw new Error("the typechecker Octokit shim no longer matches the generated itx surface");
}

const SHARED_FILES: Record<string, string> = {
  // This is generated, static declaration text. Giving it a declaration-file
  // extension lets skipLibCheck avoid rebinding and semantically checking its
  // ~4,000 lines on every tiny script check; extensionless imports still
  // resolve it normally. Keep journal-provided mount declarations as `.ts`:
  // those are untrusted inputs whose errors the checker must surface.
  "itx-types.d.ts": TYPECHECKER_ITX_TYPES,
  "runtime.d.ts": RUNTIME_SHIMS,
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      // Match the runtime, not a fixed year: scripts run in workerd on current
      // V8, so a feature the runtime has (the regex `v` flag, top-level await,
      // import.meta) must not report a target-availability error (TS1501 and
      // kin live in the 1xxx "syntax" range the gate blocks on). Pinning an old
      // target made runtime-legal scripts un-runnable.
      target: "esnext",
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
 * problems as printable strings; empty means the mount may be journaled (the
 * declaration either compiled clean or the checker couldn't render a verdict).
 *
 * A `types` string is DURABLE: it enters the journal and every later script
 * check in the scope re-compiles it. So this shares the execution gate's
 * sidecar guards, with one deliberate difference in what a guard means:
 * - A checker CRASH (code-0) or an unreachable/hung sidecar (throw, deadline)
 *   is not proof the types are wrong — allow the mount rather than hard-reject
 *   a valid declaration (and, since `provideCapability` is reachable from a
 *   running script, rather than throwing an infra error into that script).
 *   This mirrors checkItxScriptForExecution's permissive-on-non-proof stance.
 * - Pathological NESTING, by contrast, is rejected, not skipped: unlike an
 *   ephemeral script (which the gate runs unchecked), a type that would wedge
 *   tsc's parser must never enter the journal, or it wedges every future check
 *   in the scope.
 * Real, deterministic type errors still reject — that is the whole point.
 */
export async function checkCapabilityTypes(input: {
  types: string;
  typechecker: Typechecker;
  deadlineMs?: number;
}): Promise<string[]> {
  if (input.types.length > MAX_SCRIPT_CHARS) {
    return [
      `types — ${input.types.length} characters is over the ${MAX_SCRIPT_CHARS}-character check limit.`,
    ];
  }
  if (exceedsNestingDepth(input.types, MAX_NESTING_DEPTH)) {
    return [
      `types — nesting deeper than ${MAX_NESTING_DEPTH} levels; simplify the declaration ` +
        `(a type this deep would wedge the checker on every future script in this scope).`,
    ];
  }
  // A declaration that exports no top-level type is an authoring mistake, not
  // a typed mount: the first exported type IS the contract, and without one the
  // mount would silently degrade to `any` (or worse — the namespace-nested case
  // used to poison the whole scope's typecheck). This rule is LOCAL — it needs
  // no compiler — so it holds even when the sidecar is unreachable below; a
  // permissive checker failure must not let an export-less mount slip in.
  const exportLess =
    firstExportedTypeName(input.types) === undefined
      ? [
          "types — exports no top-level type/interface/class/enum; " +
            "the FIRST exported declaration names the mount's type.",
        ]
      : [];
  const fileName = mountFileName("provided");
  const moduleText = mountModuleText(input.types);
  let checked: TypecheckResult;
  try {
    checked = await withDeadline(
      input.typechecker.check({ files: { ...SHARED_FILES, [fileName]: moduleText } }),
      input.deadlineMs ?? EXECUTION_CHECK_DEADLINE_MS,
    );
  } catch {
    // Unreachable or hung sidecar — not a verdict on compilation, so allow the
    // mount, but the local export-less rule still applies.
    return exportLess;
  }
  // A code-0 crash diagnostic means "the check didn't happen", not "the types
  // are wrong" — drop it so a transient compiler crash never hard-rejects a
  // valid mount (the execution gate treats the same signal as `unchecked`).
  const realErrors = checked.diagnostics.filter((diagnostic) => diagnostic.code !== 0);
  const problems = formatProblems(realErrors, {
    label: "types",
    primaryFile: fileName,
    lineOffset: moduleText === input.types ? 0 : -1, // the injected import line
  });
  // Only surface the export-less rule when nothing else failed — a compile
  // error already tells the author their declaration is broken.
  if (problems.length === 0) return exportLess;
  // Notes are CONTEXT for failures (a budget-tripped npm package reads as a
  // plain typo without them), never verdicts: typm warns on perfectly
  // successful acquisitions, and a warning must not fail a compiling mount.
  return [...problems, ...checked.notes];
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
  // `export default script` makes the EMITTED JavaScript of this file a
  // loadable module: the execution harness imports it, so what runs is the
  // compiler's own type-stripped output — scripts are genuinely TypeScript.
  files["script.ts"] = [...prelude, code, ");", "export default script;"].join("\n");
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
  | {
      verdict: "clean";
      /** The compiler's emitted JavaScript module for the script (default
       * export = the script function). Same wasm compile as the check —
       * emit costs nothing — and it is what the runtime executes, so
       * TypeScript syntax in scripts genuinely works. */
      emittedJs?: string;
    }
  | { verdict: "problems"; problems: string[] }
  | { verdict: "unchecked"; reason: string };

/** Wall-clock budget for the pre-execution check. Generous enough for a cold
 * sidecar isolate (wasm instantiation + first compile) plus npm type
 * acquisition; past it the script runs unchecked rather than stall. */
const EXECUTION_CHECK_DEADLINE_MS = 10_000;

/**
 * What the gate may block on — an ALLOWLIST, because blocking is only sound
 * for errors that hold regardless of how complete the declared type surface
 * is. Near-miss typos qualify: the compiler PROVED a correct alternative
 * exists ("Did you mean 'get'?"). Bare "does not exist" / wrong-argument
 * errors do not: capabilities are provided dynamically (a script may mount
 * `itx.demoStream` and call it two lines later — journal-legal, invisible to
 * a static check), and the declared surface demonstrably lags the runtime in
 * places (preview e2e: `CloudflareSandbox.exec` exists at runtime but not in
 * types, handle results declared `{}`). The advisory door (checkItxScript)
 * still reports everything.
 */
const TS_PROPERTY_NEAR_MISS = 2551; // Property 'X' does not exist on type 'T'. Did you mean 'Y'?
const TS_NAME_NEAR_MISS = 2552; // Cannot find name 'X'. Did you mean 'Y'?

/** TS grammar diagnostics live in the 1xxx range. Unparseable code is the one
 * verdict that needs no type knowledge at all — the runtime's module loader
 * would reject the same script with a worse message. */
const isSyntaxError = (code: number) => code >= 1000 && code < 2000;

/** The itx root passed to a script (`itx: Itx`, where `Itx = Project & …mounts`)
 * is RUNTIME-EXTENSIBLE: a script can `provideCapability` a new top-level path
 * and call it two lines later, so a missing property ON THE ROOT is never
 * provably wrong — even when it near-misses an existing member (`itx.agentz`
 * vs `agent`, `itx.strems` vs `streams` read identically to a static check).
 * A near-miss on a CONCRETE sub-surface (`itx.streams.gett` on
 * `ProjectStreamCollection`, a typed mount's `T`) stays provable and blocks —
 * those types are not extended by a provide. Message-shaped because the type
 * name is the only signal tsc gives; the alias collapses to `Project` or `Itx`. */
const isRootExtensibleMiss = (message: string) =>
  /does not exist on type '(?:Project|Itx)'/.test(message);

/** Whether a script-own diagnostic is provable enough to STOP a run. See the
 * allowlist rationale on ScriptExecutionCheck. */
function isProvableBlocker(diagnostic: TypecheckDiagnostic): boolean {
  if (isSyntaxError(diagnostic.code)) return true;
  // A missing local (`cuont`) is always provable — locals are not runtime-
  // extensible the way the itx root is.
  if (diagnostic.code === TS_NAME_NEAR_MISS) return true;
  if (diagnostic.code === TS_PROPERTY_NEAR_MISS) return !isRootExtensibleMiss(diagnostic.message);
  return false;
}

/** Bracket-nesting depth past which the script is handed to the runtime
 * UNCHECKED instead of tsc. tsc's recursive-descent parser is synchronous and
 * uninterruptible: a ~2KB script nesting `[[[…]]]` ~1200 deep blocked the host
 * DO past its storage watchdog and forced a reset (the check's own deadline
 * fires too late — the RPC is already in flight). V8 parses the same nesting
 * in milliseconds, so bailing to the runtime is both safe and cheap. The cap
 * sits far above any real script (1000-deep checked in ~200ms; real code is
 * single digits). */
const MAX_NESTING_DEPTH = 400;

/** Cheap upper bound on bracket nesting — counts `([{` vs `)]}` without a
 * parse. Brackets inside strings/comments inflate the count, which only makes
 * the guard bail to UNCHECKED sooner: safe, since unchecked runs the script. */
function exceedsNestingDepth(code: string, limit: number): boolean {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") {
      if (++depth > limit) return true;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
    }
  }
  return false;
}

/**
 * The pre-execution typecheck for a `script-execution-requested` block:
 * everything checkItxScript checks, read through the permissive-by-default
 * policy above. Blocking requires an error diagnostic in the script's OWN
 * code (`script.ts`) from the allowlist: a syntax error or a near-miss typo.
 * Everything the checker cannot vouch for runs instead — property/argument
 * mismatches (dynamic mounts and surface gaps make them unprovable), a
 * near-miss on the runtime-extensible itx root (isRootExtensibleMiss), shapes
 * the agent extractor never produces (raw runScript callers send plain
 * function expressions), oversized or pathologically-nested scripts (the
 * latter would wedge the host before the deadline fires), broken mount
 * declarations (stale journals must not veto unrelated scripts), compiler
 * crashes, an unreachable typechecker, and the deadline. Never throws.
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
  if (exceedsNestingDepth(input.code, MAX_NESTING_DEPTH)) {
    return { verdict: "unchecked", reason: `nesting deeper than ${MAX_NESTING_DEPTH}` };
  }
  const project = assembleScriptProject(input.capabilities, input.code);
  let checked: TypecheckResult;
  try {
    checked = await withDeadline(
      input.typechecker.check({ files: project.files, entrypoint: "script.ts" }),
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
      isProvableBlocker(diagnostic),
  );
  if (blocking.length === 0) {
    // `js` can come back EMPTY when the program has errors anywhere (broken
    // mount declarations included) — the compiler emits nothing it can't
    // vouch for. Treat empty as absent: execution falls back to the raw
    // code, exactly the unchecked path's behavior.
    return { verdict: "clean", emittedJs: checked.js ? checked.js : undefined };
  }
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
        // tswasm columns are 0-based; +1 to match the 1-based line and every
        // editor's gutter (a `line:col` that disagrees on the col base misleads).
        const column = diagnostic.column === undefined ? "" : `:${diagnostic.column + 1}`;
        const position = line === undefined || line < 1 ? "" : `:${line}${column}`;
        return `${options.label}${position} — ${diagnostic.message} (TS${diagnostic.code})`;
      }
      const where = fileName.replace(/^mounts\//, "mount ").replace(/\.ts$/, "");
      return `${where}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`} — ${diagnostic.message} (TS${diagnostic.code})`;
    });
}
