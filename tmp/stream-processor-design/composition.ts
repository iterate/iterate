import type {
  Processor,
  ProcessorState,
  ProcessorStreamApi,
  StreamEvent,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";
import {
  runProcessorAfterAppend,
  runProcessorOnStart,
  runProcessorReduce,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * Same-host composition sketch.
 *
 * This composes processors without giving them direct access to each other's
 * state. Each processor gets its own state slice and sees only stream events
 * declared in its contract.
 */

export type ProcessorSlot<Contract> = {
  processor: Processor<Contract>;
  state: ProcessorState<Contract>;
  saveState(state: ProcessorState<Contract>): Promise<void>;
};

export async function startComposedProcessors<
  const Slots extends readonly ProcessorSlot<unknown>[],
>(args: { slots: Slots; streamApi: ProcessorStreamApi<unknown>; signal: AbortSignal }) {
  for (const slot of args.slots) {
    await runProcessorOnStart({
      processor: slot.processor,
      state: slot.state,
      streamApi: args.streamApi,
      signal: args.signal,
    });
  }
}

export async function deliverLiveEventToComposedProcessors(args: {
  slots: readonly ProcessorSlot<unknown>[];
  event: StreamEvent;
  streamApi: ProcessorStreamApi<unknown>;
  signal: AbortSignal;
}) {
  for (const slot of args.slots) {
    const reduction = runProcessorReduce({
      processor: slot.processor,
      event: args.event,
      state: slot.state,
    });
    if (reduction == null) continue;

    await slot.saveState(reduction.state);
    slot.state = reduction.state;

    await runProcessorAfterAppend({
      processor: slot.processor,
      ...reduction,
      streamApi: args.streamApi,
      signal: args.signal,
    });
  }
}

/**
 * Critical design point:
 *
 * The loop order is a host implementation detail. Correct processors must not
 * depend on "Codemode ran before AgentLoop" in the same delivery turn.
 *
 * If Codemode wants AgentLoop to see something, Codemode appends a new event.
 * AgentLoop sees it later as a committed fact with its own offset.
 */
