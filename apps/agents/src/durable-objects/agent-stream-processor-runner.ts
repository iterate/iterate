import { DurableObject } from "cloudflare:workers";
import { StreamSocketFrame, type StreamPath } from "@iterate-com/events-contract";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  withStreamProcessorRunner,
  type StreamProcessorRunnerState,
} from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { z } from "zod";
import {
  defineProcessorContract,
  getInitialProcessorState,
  implementProcessor,
  runProcessorAfterAppend,
  runProcessorReduce,
  type ProcessorStreamApi,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { AgentProcessorContract } from "~/stream-processors/agent/contract.ts";
import { createAgentProcessor } from "~/stream-processors/agent/implementation.ts";
import { CodemodeProcessorContract } from "~/stream-processors/codemode/contract.ts";
import { createCloudflareCodemodeCodeExecutor } from "~/stream-processors/codemode/cloudflare-code-executor.ts";
import { createCodemodeProcessor } from "~/stream-processors/codemode/implementation.ts";
import { CoreProcessorContract } from "~/stream-processors/core/contract.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

export type AgentStreamProcessorRunnerInit = {
  name: string;
  streamPath: StreamPath;
};

const AgentCodemodeProcessorContract = defineProcessorContract({
  slug: "agent-codemode",
  version: "0.1.0",
  description: "Runs the Agent and Codemode processors as one deployment unit.",
  stateSchema: z.object({
    agent: AgentProcessorContract.stateSchema,
    codemode: CodemodeProcessorContract.stateSchema,
  }),
  initialState: {
    agent: getInitialProcessorState(AgentProcessorContract),
    codemode: getInitialProcessorState(CodemodeProcessorContract),
  },
  processorDeps: [CoreProcessorContract, AgentProcessorContract, CodemodeProcessorContract],
  events: {},
  consumes: [...AgentProcessorContract.consumes, ...CodemodeProcessorContract.consumes],
  emits: [...AgentProcessorContract.emits, ...CodemodeProcessorContract.emits],
  reduce({ state, event }) {
    return {
      agent:
        runProcessorReduce({
          processor: { contract: AgentProcessorContract },
          state: state.agent,
          event,
        })?.state ?? state.agent,
      codemode:
        runProcessorReduce({
          processor: { contract: CodemodeProcessorContract },
          state: state.codemode,
          event,
        })?.state ?? state.codemode,
    };
  },
});

/**
 * Temporary local composition of two processors into the single processor shape
 * expected by `withStreamProcessorRunner(...)`.
 *
 * This should become a shared `combineProcessors(...)` helper. Keep it here for
 * now so the Durable Object runner can stay single-processor while we prove the
 * exact composition semantics with the concrete Agent + Codemode example.
 */
function createAgentCodemodeProcessor(args: { ctx: DurableObjectState; env: CloudflareEnv }) {
  const agentProcessor = createAgentProcessor({
    ai: {
      /**
       * `Ai.run` is model-specific in Cloudflare's generated types, while the
       * processor deliberately receives a tiny model-agnostic surface. Keep
       * the Worker binding cast at this boundary so the processor can still
       * run in tests or another runner with any compatible executor.
       */
      run: async (model, body, runOpts) =>
        await args.env.AI.run(model as never, body as never, runOpts as never),
    },
    waitUntil: (promise) => args.ctx.waitUntil(promise),
  });
  const codemodeProcessor = createCodemodeProcessor({
    codeExecutor: createCloudflareCodemodeCodeExecutor({
      loader: args.env.LOADER,
      outboundFetch: args.env.CODEMODE_OUTBOUND_FETCH,
    }),
    env: args.env,
  });

  return implementProcessor(AgentCodemodeProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    onStart({ state, streamApi, signal }) {
      return Promise.all([
        agentProcessor.implementation.onStart?.({
          state: state.agent,
          streamApi: streamApi as unknown as ProcessorStreamApi<typeof AgentProcessorContract>,
          signal,
        }),
        codemodeProcessor.implementation.onStart?.({
          state: state.codemode,
          streamApi: streamApi as unknown as ProcessorStreamApi<typeof CodemodeProcessorContract>,
          signal,
        }),
      ]).then(() => undefined);
    },

    async afterAppend({ event, previousState, state, streamApi, signal }) {
      const agentReduction = runProcessorReduce({
        processor: agentProcessor,
        event,
        state: previousState.agent,
      });
      if (agentReduction != null) {
        await runProcessorAfterAppend({
          processor: agentProcessor,
          event: agentReduction.event,
          previousState: agentReduction.previousState,
          state: state.agent,
          streamApi: streamApi as unknown as ProcessorStreamApi<typeof AgentProcessorContract>,
          signal,
        });
      }

      const codemodeReduction = runProcessorReduce({
        processor: codemodeProcessor,
        event,
        state: previousState.codemode,
      });
      if (codemodeReduction != null) {
        await runProcessorAfterAppend({
          processor: codemodeProcessor,
          event: codemodeReduction.event,
          previousState: codemodeReduction.previousState,
          state: state.codemode,
          streamApi: streamApi as unknown as ProcessorStreamApi<typeof CodemodeProcessorContract>,
          signal,
        });
      }
    },
  });
}

function createAgentCodemodeProcessorForRunner(args: {
  ctx: DurableObjectState;
  env: CloudflareEnv;
}) {
  return createAgentCodemodeProcessor({
    ctx: args.ctx,
    env: args.env,
  });
}

const AgentStreamProcessorRunnerBase = withStreamProcessorRunner<
  AgentStreamProcessorRunnerInit,
  CloudflareEnv,
  typeof AgentCodemodeProcessorContract
>({
  processor: createAgentCodemodeProcessorForRunner,
  streamApi(args) {
    return createStreamApi({
      ctx: args.ctx,
      streamPath: args.initParams.streamPath,
    });
  },
})(withLifecycleHooks<AgentStreamProcessorRunnerInit>()(withDurableObjectCore(DurableObject)));

export type AgentStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof AgentCodemodeProcessorContract
>;

/**
 * Durable Object runner for the agent and codemode processors.
 *
 * The generic mixin owns processor state persistence and the reduce/afterAppend
 * loop. This class owns only the push WebSocket endpoint used by Events and the
 * app-specific processor dependencies configured above.
 */
export class AgentStreamProcessorRunner extends AgentStreamProcessorRunnerBase<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async () => {
      await this.catchUp();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    await this.ensureStarted();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = websocketMessageToString(message);
    if (text == null) return;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success || frame.data.type !== "event") return;

    await this.consumeEvent({ event: frame.data.event });
  }

  async catchUp(): Promise<AgentStreamProcessorRunnerState> {
    return await this.catchUpStreamProcessor();
  }

  async consumeEvent(args: { event: StreamEvent }): Promise<AgentStreamProcessorRunnerState> {
    return await this.consumeStreamProcessorEvent(args);
  }

  async getRunnerState(): Promise<AgentStreamProcessorRunnerState> {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }
}

function createStreamApi<Contract>(args: {
  ctx: DurableObjectState;
  streamPath: string;
}): ProcessorStreamApi<Contract> {
  /**
   * `StreamApi` is a named WorkerEntrypoint exported from the same module.
   * The runtime instance has the `ProcessorStreamApi` methods; Cloudflare's
   * generated `ctx.exports` type does not currently preserve those generics.
   */
  const ctx = args.ctx as DurableObjectState & {
    exports: {
      StreamApi(args: { props: { streamPath: string } }): unknown;
    };
  };

  return ctx.exports.StreamApi({
    props: { streamPath: args.streamPath },
  }) as unknown as ProcessorStreamApi<Contract>;
}

function websocketMessageToString(message: string | ArrayBuffer): string | null {
  if (typeof message === "string") return message;
  return new TextDecoder().decode(message);
}
