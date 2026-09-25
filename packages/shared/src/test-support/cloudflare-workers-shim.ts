// Node-side stand-in for the `cloudflare:workers` module, aliased by the Node unit tests of apps/os,
// apps/dummy-petshop and packages/iterate (each vitest.config.ts). It exists so a module whose only
// platform dependency is a base class (RpcTarget, WorkerEntrypoint, DurableObject) can load in plain
// Node without a per-file `vi.mock("cloudflare:workers")` (iterate/no-vi-mock). It proves nothing
// about the runtime: class bodies never run as Workers here, and `env` is empty. Behaviour that needs
// workerd belongs in apps/os's workers project (__workers-tests__/). Types still come from
// @cloudflare/workers-types; the alias replaces the module at run time only.

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
  protected ctx: unknown;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
