import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import itxTypesSource from "~/types.ts?raw";

export type ItxReplTypeScriptWorker = WorkerShape & {
  getAutocompletionWithDocs(input: {
    context: Pick<CompletionContext, "explicit" | "pos">;
    path: string;
  }): Promise<CompletionResult | null>;
};

/**
 * Where the design-of-record itx surface lives in the REPL's virtual
 * filesystem. The prelude below imports it as `./itx-types.ts`, so keep the
 * two in sync if this ever moves.
 */
export const ITX_TYPES_PATH = "/itx-types.ts";

/**
 * The design-of-record itx surface (`~/types.ts`), verbatim. That file is
 * handwritten and import-free, so its raw source is a valid standalone module
 * for the editor's virtual filesystem — completions and hover docs in the
 * browser REPL come from THE type file, and cannot drift from it.
 */
export const itxTypesDeclaration: string = itxTypesSource;

/**
 * REPL prelude for the editor's virtual filesystem. Only what
 * `~/types.ts` does not cover lives here: the session globals the REPL
 * runtime actually injects (see `~/itx/browser-repl.ts`), ambient shims for
 * the workers-runtime globals the raw type file references (`Disposable`,
 * `ExecutionContext` — the editor's lib is es2022 + dom), and global aliases
 * so snippets can name the types without importing them.
 *
 * The REPL handle is typed `Session & Itx` — the same pragmatic intersection
 * `~/itx/itx-react.tsx` uses: a project REPL holds the project itx, the
 * global/admin REPL holds the Session catalog, and a wrong call for the
 * context fails at runtime exactly like a missing capability would. Dynamic
 * capabilities (`itx.someMountedCap...`) are runtime-typed: the editor flags
 * them, the engine resolves them.
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

  /** Live-stub base class for capability providers (from capnweb). */
  class RpcTarget {}

  // The design-of-record types, exposed globally so snippets can annotate
  // with them without an import. Shapes live in ./itx-types.ts only.
  type Session = itxTypes.Session;
  type Itx = itxTypes.Itx;
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
   * The connected handle for this REPL session. A project REPL holds the
   * project itx; the global/admin REPL holds the Session catalog. Awaiting is
   * always allowed: over Cap'n Web every member resolves as a promise.
   */
  const itx: itxTypes.Session & itxTypes.Itx;
  /**
   * Script parameters — always in scope, so the catalogue examples
   * (src/itx/examples.ts) run unchanged in every runtime. Assign your own
   * (\`const vars = { … }\`) to parameterize a snippet by hand.
   */
  const vars: Record<string, any>;
  /** Set in a project REPL; undefined in the global one. */
  const projectId: string | undefined;
  /** The last successful REPL result. */
  let $_: unknown;
  /** Alias for the last successful REPL result. */
  let _: unknown;
}

/**
 * REPL imports resolve at runtime (bare specifiers via esm.sh); the editor
 * cannot typecheck them, so every module is \`any\`. Relative imports still
 * resolve to real files, so this never shadows ./itx-types.ts.
 */
declare module "*";

export {};
`;
