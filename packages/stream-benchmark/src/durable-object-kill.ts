/**
 * Forcibly reset a Durable Object instance. Not catchable in application code.
 * https://developers.cloudflare.com/durable-objects/api/state/#abort
 */
export function killDurableObject(args: { ctx: DurableObjectState; reason?: string }): never {
  args.ctx.abort(args.reason ?? "kill requested");
  throw new Error("Durable Object aborted");
}
