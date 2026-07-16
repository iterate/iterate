declare module "cloudflare:workers" {
  export const tracing: {
    enterSpan<Result>(
      name: string,
      callback: (span: {
        setAttribute(name: string, value: string | number | boolean): void;
      }) => Result,
    ): Result;
  };

  export abstract class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    protected env: Env;
    protected ctx: {
      props: Props;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: DurableObjectState;
  }
}

// Minimal ambient stand-ins for @cloudflare/workers-types globals referenced
// (type-only) by apps/os/src source that the chat TUI imports. This
// package runs in node/bun, so structural stubs are enough for typechecking.
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  readonly exports: Record<string, unknown>;
  waitUntil(promise: Promise<unknown>): void;
  props: unknown;
}

/** Structural subset used by the SDK's Durable Object processor registry. */
interface DurableObjectStorage {
  readonly kv: {
    get<Value>(key: string): Value | undefined;
    put<Value>(key: string, value: Value): void;
    delete(key: string): void;
  };
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

interface AlarmInvocationInfo {
  readonly isRetry: boolean;
  readonly retryCount: number;
}
