// The re-exported apps/os `Stream` Durable Object references a global `Env`
// type (its own generated worker-configuration binding type). We don't import
// that generated file, so provide a permissive ambient so the engine source
// type-checks from this package. Our own worker uses a local `Env` interface
// (server.ts), which this does not affect.
declare global {
  interface Env {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
}

export {};
