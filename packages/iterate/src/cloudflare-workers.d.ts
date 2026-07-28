/**
 * The `iterate` package is mostly a Node/Bun CLI and browser SDK, so its main
 * TypeScript program deliberately uses Node and DOM globals. Loading the full
 * `@cloudflare/workers-types` ambient set here would make those non-Worker
 * entrypoints compile against workerd's versions of shared web APIs.
 *
 * These narrow structural declarations cover only the Worker seams used by
 * package-owned source. OS builds and checks that source with the official
 * Cloudflare types, and workerd supplies the real implementations at runtime.
 * Keep this list minimal rather than treating it as a substitute runtime API.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    protected env: Env;
    protected ctx: {
      props: Props;
    };
    constructor(ctx: unknown, env: Env);
  }
  export abstract class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: DurableObjectState;
    constructor(ctx: DurableObjectState, env: Env);
  }
  /** Structural stub of workerd's RPC base class (the processor host's wake
   * door extends it so the `processor` property survives Workers RPC). */
  export class RpcTarget {}
  /** Structural stub of workerd's tracing API (the processor registry wraps
   * alarm fires in a span). Real spans exist only inside workerd; this keeps
   * the package program checking, and apps/os re-checks the same source
   * against the real types. */
  export const tracing: {
    enterSpan<T>(name: string, fn: (span: TracingSpanStub) => T): T;
  };
}

// Minimal ambient stand-ins for @cloudflare/workers-types globals referenced
// (type-only) by apps/os/src source that the chat TUI imports. This
// package runs in node/bun, so structural stubs are enough for typechecking.
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface TracingSpanStub {
  setAttribute(key: string, value: unknown): void;
}

interface DurableObjectStorage {
  kv: {
    get<T = unknown>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    delete(key: string): boolean;
  };
  sql: {
    exec(
      query: string,
      ...bindings: any[]
    ): {
      rowsWritten: number;
      toArray(): unknown[];
    };
  };
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

interface AlarmInvocationInfo {
  isRetry: boolean;
  retryCount: number;
}

interface ExecutionContext {
  readonly exports: Record<string, unknown>;
  waitUntil(promise: Promise<unknown>): void;
  props: unknown;
}
