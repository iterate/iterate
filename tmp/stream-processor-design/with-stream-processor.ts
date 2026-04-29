import { DurableObject } from "cloudflare:workers";
import type {
  Processor,
  ProcessorState,
  ProcessorStreamApi,
  StreamEvent,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";
import {
  getProcessorStateSchema,
  runProcessorAfterAppend,
  runProcessorOnStart,
  runProcessorReduce,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * Possible durable-object-utils mixin API.
 *
 * This follows the repo's mixin style:
 *
 *   const Base = withStreamProcessor({ createProcessor, createStreamApi })(
 *     withDurableObjectCore(DurableObject),
 *   );
 *
 *   export class AgentLoopProcessorDO extends Base<Env> {}
 *
 * This is a sketch only. If we implement this for real, use the
 * `adding-a-new-durable-object-mixin` skill and add type/unit tests under
 * `packages/shared/src/durable-object-utils`.
 */

type DurableObjectConstructor = abstract new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject;

export function withStreamProcessor<Contract extends { slug: string; state: unknown }>(options: {
  createProcessor(args: { ctx: DurableObjectState; env: unknown }): Processor<Contract>;
  createStreamApi(args: {
    ctx: DurableObjectState;
    env: unknown;
    streamPath?: string;
  }): ProcessorStreamApi<Contract>;
}) {
  return function applyStreamProcessorMixin<TBase extends DurableObjectConstructor>(Base: TBase) {
    abstract class StreamProcessorMixin extends Base {
      #processor: Processor<Contract>;
      #state: ProcessorState<Contract> | null = null;
      #startedByStreamPath = new Set<string>();

      constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        this.#processor = options.createProcessor({ ctx, env });
      }

      async processStreamEvent(args: { streamPath: string; event: StreamEvent }) {
        const state = await this.#loadState();
        const streamApi = options.createStreamApi({
          ctx: this.ctx,
          env: this.env,
          streamPath: args.streamPath,
        });
        const signal = new AbortController().signal;

        if (!this.#startedByStreamPath.has(args.streamPath)) {
          await runProcessorOnStart({
            processor: this.#processor,
            state,
            streamApi,
            signal,
          });
          this.#startedByStreamPath.add(args.streamPath);
        }

        const reduction = runProcessorReduce({
          processor: this.#processor,
          event: args.event,
          state,
        });
        if (reduction == null) return;

        await this.#saveState(reduction.state);
        await runProcessorAfterAppend({
          processor: this.#processor,
          ...reduction,
          streamApi,
          signal,
        });
      }

      async #loadState() {
        if (this.#state != null) return this.#state;
        const stored = await this.ctx.storage.kv.get<unknown>("stream-processor-state");
        this.#state = getProcessorStateSchema(this.#processor.contract).parse(stored);
        return this.#state;
      }

      async #saveState(state: ProcessorState<Contract>) {
        this.#state = state;
        await this.ctx.storage.kv.put("stream-processor-state", state);
      }
    }

    return StreamProcessorMixin;
  };
}

/**
 * Main warning:
 *
 * This mixin is easy for one stream per DO. It is not enough for n streams in
 * one DO unless state is keyed by stream path:
 *
 *   stream-processor-state:/agents/a
 *   stream-processor-state:/agents/b
 *
 * That should probably be a separate option or separate mixin later, not a
 * boolean on day one.
 */
