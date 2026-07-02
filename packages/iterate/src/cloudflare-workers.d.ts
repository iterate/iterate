declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    protected env: Env;
    protected ctx: {
      props: Props;
    };
  }
}

// Minimal ambient stand-ins for @cloudflare/workers-types globals referenced
// (type-only) by apps/os/src/next source that the chat TUI imports. This
// package runs in node/bun, so structural stubs are enough for typechecking.
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  readonly exports: Record<string, unknown>;
  waitUntil(promise: Promise<unknown>): void;
  props: unknown;
}
