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
 * Pull runner sketch.
 *
 * This is the deployment mode for processors that subscribe to a stream from
 * outside the Events Durable Object. It is appropriate for AgentLoop and
 * Codemode if we run each as its own worker/DO.
 */

export async function runPullProcessor<
  const Contract extends { slug: string; state: unknown },
>(args: {
  processor: Processor<Contract>;
  loadState(): Promise<unknown | undefined>;
  saveState(state: ProcessorState<Contract>): Promise<void>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}) {
  let state = getProcessorStateSchema(args.processor.contract).parse(
    await args.loadState(),
  ) as ProcessorState<Contract>;

  /**
   * Historic replay is reducer-only. It must not call afterAppend because
   * afterAppend appends derived events and calls third-party APIs.
   */
  const historicEvents = await args.streamApi.read({ beforeOffset: "end" });
  for (const event of historicEvents) {
    const reduction = runProcessorReduce({
      processor: args.processor,
      event,
      state,
    });
    if (reduction == null) continue;
    state = reduction.state;
  }

  await args.saveState(state);
  await runProcessorOnStart({
    processor: args.processor,
    state,
    streamApi: args.streamApi,
    signal: args.signal,
  });

  /**
   * Live subscription uses reduce, then host persistence, then afterAppend.
   */
  for await (const event of args.streamApi.subscribe({ afterOffset: "end", signal: args.signal })) {
    const next = await processLiveEvent({
      processor: args.processor,
      state,
      event,
      saveState: args.saveState,
      streamApi: args.streamApi,
      signal: args.signal,
    });
    state = next;
  }
}

async function processLiveEvent<const Contract>(args: {
  processor: Processor<Contract>;
  state: ProcessorState<Contract>;
  event: StreamEvent;
  saveState(state: ProcessorState<Contract>): Promise<void>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}) {
  const reduction = runProcessorReduce({
    processor: args.processor,
    event: args.event,
    state: args.state,
  });
  if (reduction == null) return args.state;

  await args.saveState(reduction.state);
  await runProcessorAfterAppend({
    processor: args.processor,
    ...reduction,
    streamApi: args.streamApi,
    signal: args.signal,
  });
  return reduction.state;
}

/**
 * Open design pressure:
 *
 * The runner still needs a durable way to remember "how far did I subscribe".
 * If state is replayed from the whole history on each start, no cursor is
 * needed, but that gets expensive. If the host caches reduced state, it also
 * needs to know the last reduced offset.
 *
 * Recommendation: host storage owns `{ state, reducedThroughOffset }`, but
 * this should stay out of the processor contract.
 */
