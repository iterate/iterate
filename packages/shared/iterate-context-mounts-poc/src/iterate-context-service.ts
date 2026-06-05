import { WorkerEntrypoint } from "cloudflare:workers";
import type { IterateContextCapability } from "./iterate-context.ts";
import type { IterateContextHostEnv } from "./iterate-context.ts";

const contexts = new Map<string, IterateContextCapability>();

export function registerIterateContext(context: IterateContextCapability) {
  const contextId = crypto.randomUUID();
  contexts.set(contextId, context);
  return contextId;
}

export function unregisterIterateContext(contextId: string) {
  contexts.delete(contextId);
}

export class IterateContextService extends WorkerEntrypoint<
  IterateContextHostEnv,
  { contextId: string }
> {
  getIterateContext(): IterateContextCapability {
    const context = contexts.get(this.ctx.props.contextId);
    if (!context) {
      throw new Error(`Unknown iterate context id: ${this.ctx.props.contextId}`);
    }
    return context;
  }
}
