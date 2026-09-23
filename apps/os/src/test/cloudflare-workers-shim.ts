// Node-side stand-in for the `cloudflare:workers` module, aliased for the unit project in
// apps/os/vitest.config.ts (the legacy apps/os unit lane did the same). It exists so a module whose
// only platform dependency is a base class (RpcTarget, WorkerEntrypoint, DurableObject) can load in
// plain Node without a per-file `vi.mock("cloudflare:workers")` (iterate/no-vi-mock). It proves
// nothing about the runtime: class bodies never run as Workers here, and `env` is empty. Behaviour
// that needs workerd belongs in the workers lane (__workers-tests__/).

export class RpcTarget {}
export class RpcStub {}
export class RpcPromise {}
export class RpcProperty {}
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  env!: Env;
  ctx!: {
    props: Props;
    exports: Record<string, unknown>;
    waitUntil(promise: Promise<unknown>): void;
  };
}
export class DurableObject<Env = unknown> {
  protected env: Env;
  protected ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
