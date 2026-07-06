// Minimal Node-side stand-in for the `cloudflare:workers` module, aliased in
// vitest.config.ts (same pattern as apps/os). It exists so the state Durable
// Object — whose only platform dependency is the DurableObject base class —
// can be unit tested in plain Node over an in-memory storage fake.
// Deliberately exports nothing else: any other cloudflare:workers import
// reaching a Node test fails loudly instead of being silently faked.

export class DurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
