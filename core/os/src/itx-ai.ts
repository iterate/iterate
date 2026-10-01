// itx-ai.ts — THE PLATFORM'S WORKERS AI: `ItxAi`, the stateless entrypoint a context's built-in
// `itx.ai` root is a stub of (context/built-ins.ts). Every Workers AI call a context makes passes
// through it, so the call starts in a stateless invocation rather than in the context's Durable
// Object. Its props name the project the call is made for: where a meter or an attribution goes.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { IterateContextApi } from "iterate/api";
import type { Env } from "./iterate-context-durable-object.ts";

/** Workers AI's `run` and `models`, passed straight through to the binding. */
export class ItxAi extends WorkerEntrypoint<Env, { projectId: string }> {
  run(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<unknown> {
    return this.env.AI.run(model, inputs, options);
  }

  models(params?: AiModelsSearchParams): Promise<AiModelsSearchObject[]> {
    return this.env.AI.models(params);
  }
}

/** Mint `ItxAi` for one project — `ctx.exports.ItxAi({ props })` on a context's Durable Object's
 *  state, or on the stateless entrypoint's execution context (context/stateless-context.ts). The
 *  cast: `Cloudflare.Exports` is `{}` without a generated `GlobalProps` (as for `itxEntrypointFor`),
 *  and the stub answers the two methods the published `itx.ai` names. */
export function itxAiFor(
  ctx: DurableObjectState | ExecutionContext,
  projectId: string,
): IterateContextApi["ai"] {
  const { exports } = ctx as unknown as {
    exports: { ItxAi(opts: { props: { projectId: string } }): IterateContextApi["ai"] };
  };
  return exports.ItxAi({ props: { projectId } });
}
