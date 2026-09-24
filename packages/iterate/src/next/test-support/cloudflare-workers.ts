/** Node test replacement for the Workers base class used by app-session.ts. */
export class DurableObject {
  readonly ctx: DurableObjectState;
  readonly env: unknown;
  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
