/*
 * apps/kit's browser-facing TypeScript project intentionally uses the DOM
 * libraries, while this subdirectory is copied into a workerd dynamic worker.
 * These are the three workerd-only additions used by the worker. Keeping this
 * declaration beside the copied source lets local typechecking verify the real
 * implementation without making the browser bundle depend on Workers types.
 */
interface WebSocket {
  accept(): void;
}

declare class WebSocketPair {
  readonly 0: WebSocket;
  readonly 1: WebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket;
}

/*
 * The local workspace export of `iterate/sdk` points at its TypeScript source.
 * Its published build is compiled against workerd already, but apps/kit's DOM
 * program still needs this narrow structural view while checking the copied
 * worker. Do not grow this into a second Workers API definition: add only
 * shapes referenced by the public SDK source.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    protected env: Env;
    protected ctx: { props: Props };
    constructor(ctx: unknown, env: Env);
  }

  export abstract class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: DurableObjectState;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export class RpcTarget {}

  export const tracing: {
    enterSpan<T>(name: string, fn: (span: TracingSpanStub) => T): T;
  };
}

interface DurableObjectStorage {
  kv: {
    delete(key: string): boolean;
    get<T = unknown>(key: string): T | undefined;
    put(key: string, value: unknown): void;
  };
  sql: {
    exec(
      query: string,
      ...bindings: unknown[]
    ): {
      rowsWritten: number;
      toArray(): unknown[];
    };
  };
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

interface AlarmInvocationInfo {
  isRetry: boolean;
  retryCount: number;
}

interface TracingSpanStub {
  setAttribute(key: string, value: unknown): void;
}
