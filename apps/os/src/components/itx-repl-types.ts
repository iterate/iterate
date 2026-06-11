import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import itxTypesSource from "~/itx/types.ts?raw";

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
 * The design-of-record itx surface (`~/itx/types.ts`), verbatim. That file is
 * handwritten and import-free, so its raw source is a valid standalone module
 * for the editor's virtual filesystem — completions and hover docs in the
 * browser REPL come from THE type file, and cannot drift from it.
 */
export const itxTypesDeclaration: string = itxTypesSource;

/**
 * REPL prelude for the editor's virtual filesystem. Only what
 * `~/itx/types.ts` does not cover lives here: the session globals the REPL
 * runtime actually injects (see `~/itx/browser-repl.ts`), the capability
 * fallthrough surface, and global aliases so snippets can name the types
 * without importing them.
 */
export const itxReplDeclaration = `
import type * as itxTypes from "./itx-types.ts";

declare module "./itx-types.ts" {
  /**
   * The editor's view of the capability fallthrough: unknown property names
   * complete as callable capability paths. Merging this into KnownCapabilities means
   * EVERY handle carries it — including ones returned by \`extend()\` and
   * \`itx.projects.get()\`.
   */
  interface KnownCapabilities {
    [capability: string]: CapabilitySurface;
  }
}

declare global {
  /** Live-stub base class for capability providers (from capnweb). */
  class RpcTarget {}

  /**
   * Wrap a plain object-of-methods (or a bare function) so it speaks the
   * kernel's one calling convention and can be provided as a LIVE capability:
   * the wrapper crosses the session as a stub and replays each
   * call({ path, args }) back here, on your concrete object.
   */
  function asPathCallable(target: object): PathCallTarget;

  /**
   * Anything not declared on the itx builtins resolves through the capability
   * fallthrough. Property access accumulates a path locally, then the
   * terminal call dispatches once: \`itx.slack.chat.postMessage(...)\`.
   */
  type CapabilitySurface = {
    (...args: any[]): Promise<unknown>;
    [segment: string]: CapabilitySurface;
  };

  // The design-of-record types, exposed globally so snippets can annotate
  // with them without an import. Shapes live in ./itx-types.ts only.
  type Itx = itxTypes.Itx;
  type ItxHandle = itxTypes.ItxHandle;
  type ItxBuiltins = itxTypes.ItxBuiltins;
  type KnownCapabilities = itxTypes.KnownCapabilities;
  type ItxDescription = itxTypes.ItxDescription;
  type CapabilityTarget = itxTypes.CapabilityTarget;
  type WorkerRef = itxTypes.WorkerRef;
  type CapabilitySource = itxTypes.CapabilitySource;
  type PathCall = itxTypes.PathCall;
  type PathCallTarget = itxTypes.PathCallTarget;
  type LiveStub = itxTypes.LiveStub;
  type CapabilityMeta = itxTypes.CapabilityMeta;
  type CapabilityDescription = itxTypes.CapabilityDescription;
  type StreamRef = itxTypes.StreamRef;
  type StreamEvent = itxTypes.StreamEvent;
  type StreamEventInput = itxTypes.StreamEventInput;
  type StreamState = itxTypes.StreamState;
  type ItxStream = itxTypes.ItxStream;
  type ItxStreams = itxTypes.ItxStreams;
  type ItxProjects = itxTypes.ItxProjects;
  type ItxFn<R = unknown> = itxTypes.ItxFn<R>;
  type Stubify<T> = itxTypes.Stubify<T>;
  type ContextRef = itxTypes.ContextRef;
  type ItxPrincipal = itxTypes.ItxPrincipal;
  type ItxProps = itxTypes.ItxProps;

  /** The connected Iterate context handle for this REPL session. */
  const itx: ItxHandle;
  /** Environment-style values injected into this REPL session. */
  const env: Record<string, unknown>;
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
