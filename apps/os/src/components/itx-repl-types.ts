import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import { itxTypesFileText } from "~/domains/itx/itx-types-text.ts";

export type ItxReplTypeScriptWorker = WorkerShape & {
  getAutocompletionWithDocs(input: {
    context: Pick<CompletionContext, "explicit" | "pos">;
    path: string;
  }): Promise<CompletionResult | null>;
  /** Feed the scope's assembled preamble into the virtual filesystem so
   * `results` completes with real types. Best-effort: false = not applied. */
  setScopeContext(input: { preambleTs: string | null }): Promise<boolean>;
};

/**
 * Where the design-of-record itx surface lives in the REPL's virtual
 * filesystem. The prelude below imports it as `./itx-types.ts`, so keep the
 * two in sync if this ever moves.
 */
export const ITX_TYPES_PATH = "/itx-types.ts";

/**
 * The public itx surface as one standalone module for the editor's virtual
 * filesystem (see domains/itx/itx-types-text.ts — the typechecker's virtual
 * project loads the same text), so completions and hover docs in the browser
 * REPL come from THE type surface.
 */
export const itxTypesDeclaration: string = itxTypesFileText;

/**
 * REPL prelude for the editor's virtual filesystem. Only what
 * `~/itx-api.generated.ts` does not cover lives here: the globals the script
 * runtime injects (`itx`, `vars` — the wrap in
 * itx-scope-repl-entries.ts declares `vars` when the body doesn't), ambient
 * shims for the workers-runtime globals the raw type file references
 * (`Disposable`, `ExecutionContext` — the editor's lib is es2022 + dom), and
 * global aliases so snippets can name the types without importing them.
 *
 * The REPL always holds a PROJECT context now (runs execute server-side in a
 * per-user scope whose capability reads fall back to the project root), so
 * `itx` is the Project surface — the same alias base the server-side typecheck
 * gate uses. Dynamic capabilities (`itx.someMountedCap...`) are runtime-typed:
 * the editor flags them, itx resolves them. The `results` global is NOT here:
 * it is scope state, fed in per scope via `setScopeContext` (see
 * {@link replScopeModules}); without results the name correctly doesn't exist.
 */
export const itxReplDeclaration = `
import type * as itxTypes from "./itx-types.ts";

declare global {
  // ── Ambient shims ─────────────────────────────────────────────────────────
  // ./itx-types.ts is written against the workers runtime; the editor's
  // virtual TS environment loads es2022 + dom, which lack explicit resource
  // management and ExecutionContext. Declare just enough for it to typecheck.
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
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    readonly exports: Record<string, unknown>;
    readonly props: unknown;
  }

  // The design-of-record types, exposed globally so snippets can annotate
  // with them without an import. Shapes live in ./itx-types.ts only.
  type Session = itxTypes.Session;
  type Project = itxTypes.Project;
  type Agent = itxTypes.Agent;
  type AgentChat = itxTypes.AgentChat;
  type Stream = itxTypes.Stream;
  type StreamEvent = itxTypes.StreamEvent;
  type StreamEventInput = itxTypes.StreamEventInput;
  type StreamEventBatch = itxTypes.StreamEventBatch;
  type StreamListItem = itxTypes.StreamListItem;
  type Repo = itxTypes.Repo;
  type CommitRepoFilesInput = itxTypes.CommitRepoFilesInput;
  type CommitRepoFilesResult = itxTypes.CommitRepoFilesResult;
  type EditRepoFileInput = itxTypes.EditRepoFileInput;
  type EditRepoFileResult = itxTypes.EditRepoFileResult;
  type Secret = itxTypes.Secret;
  type SecretDescription = itxTypes.SecretDescription;
  type SecretUpdateInput = itxTypes.SecretUpdateInput;
  type ProjectDescription = itxTypes.ProjectDescription;
  type CapabilityDescription = itxTypes.CapabilityDescription;
  type CapabilityProvision = itxTypes.CapabilityProvision;
  type ProvideCapabilityInput = itxTypes.ProvideCapabilityInput;
  type RevokeCapabilityInput = itxTypes.RevokeCapabilityInput;
  type ItxExpression = itxTypes.ItxExpression;
  type DynamicWorkerRef = itxTypes.DynamicWorkerRef;
  type DynamicWorkerSource = itxTypes.DynamicWorkerSource;
  type StatelessDynamicWorkerRef = itxTypes.StatelessDynamicWorkerRef;
  type StatefulDynamicWorkerRef = itxTypes.StatefulDynamicWorkerRef;
  type ProjectWorker = itxTypes.ProjectWorker;
  type ProjectEgress = itxTypes.ProjectEgress;
  type JsonValue = itxTypes.JsonValue;

  /**
   * The itx your script runs against: the project surface, scoped to your
   * personal REPL scope (capability reads fall back to the project root).
   * Every member resolves as a promise.
   */
  const itx: itxTypes.Project;
  /**
   * Script parameters — always in scope, so the catalogue examples
   * (src/itx/examples.ts) run unchanged in every runtime. Assign your own
   * (\`const vars = { … }\`) to parameterize a snippet by hand.
   */
  const vars: Record<string, any>;
}

export {};
`;

/** The scope preamble module in the editor's virtual filesystem — the scope's
 * assembled preamble compiles here, and its \`results\` value is re-exported. */
export const REPL_SCOPE_PREAMBLE_PATH = "/repl-scope-preamble.ts";
/** Global declarations bridging the scope module into the snippet's scope. */
export const REPL_SCOPE_GLOBALS_PATH = "/repl-scope-globals.d.ts";
/** What both scope files hold when the scope has nothing to inject. */
export const EMPTY_REPL_SCOPE_MODULE = "export {};\n";

/**
 * Render the two virtual-filesystem files that make a scope's `results` array
 * autocomplete with its real types: the preamble module (the scope's
 * platform-assembled preamble verbatim, with the `Itx` alias its large-result
 * loaders reference) and a globals file declaring `results` as that module's
 * value. When the preamble carries no `results` section the files go empty —
 * the name correctly doesn't exist until a script has settled. Everything here
 * is best-effort editor sugar; the server-side typecheck gate is authoritative.
 */
export function replScopeModules(preambleTs: string | null): {
  globals: string;
  preamble: string;
} {
  if (!preambleTs || !preambleTs.includes("const __resultRows = [")) {
    return { globals: EMPTY_REPL_SCOPE_MODULE, preamble: EMPTY_REPL_SCOPE_MODULE };
  }
  const preamble = [
    `import type * as itxTypes from "./itx-types.ts";`,
    // The preamble's large-result loaders are typed `load(itx: Itx)`; the
    // gate aliases Itx to the Project surface plus mount types. Mount types
    // are out of (cheap) reach here — Project alone keeps the file compiling.
    `type Itx = itxTypes.Project;`,
    preambleTs,
    `export const __replResults = results;`,
    ``,
  ].join("\n");
  const globals = [
    `declare global {`,
    `  /** Prior script results in this REPL scope, newest first: results[0].data`,
    `   * inline, await results[N].load(itx) for large results. */`,
    `  const results: typeof import(".${REPL_SCOPE_PREAMBLE_PATH}").__replResults;`,
    `}`,
    `export {};`,
    ``,
  ].join("\n");
  return { globals, preamble };
}
