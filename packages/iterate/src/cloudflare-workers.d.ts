declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    protected env: Env;
    protected ctx: {
      props: Props;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: unknown;
  }
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
