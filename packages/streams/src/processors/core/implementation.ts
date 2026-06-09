// Implements the built-in "core" processor.
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers.

import type { StreamEvent, StreamEventInput } from "../../shared/event.ts";
import { StreamProcessor, type ProcessEventArgs, type ReduceArgs } from "../../stream-processor.ts";
import { getInitialProcessorState, runProcessorReduce } from "../../shared/stream-processors.ts";
import { coreProcessorContract, type CoreProcessorState } from "./contract.ts";

export const CoreProcessorContract = coreProcessorContract;
export type CoreProcessorContract = typeof CoreProcessorContract;

export type CoreStreamProcessorDeps = {
  propagateChildStreamCreated: (state: CoreProcessorState) => Promise<void> | void;
};

export class CoreStreamProcessor extends StreamProcessor<
  CoreProcessorContract,
  CoreStreamProcessorDeps
> {
  readonly contract = CoreProcessorContract;

  validateAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    if (!args.state.paused) return;

    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
        return;
      default:
        throw new Error(`stream paused: ${args.state.pauseReason ?? "circuit breaker open"}`);
    }
  }

  public reduce(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState;
  public override reduce(args: ReduceArgs<CoreProcessorContract>): CoreProcessorState;
  public reduce(
    args: ReduceArgs<CoreProcessorContract> | { event: StreamEvent; state: CoreProcessorState },
  ): CoreProcessorState {
    const reduction = runProcessorReduce({
      processor: { contract: this.contract },
      event: args.event as StreamEvent,
      state: args.state as CoreProcessorState,
    });
    if (reduction === undefined) {
      throw new Error(`core processor cannot reduce event type "${args.event.type}"`);
    }
    return this.contract.stateSchema.parse(reduction.state) as CoreProcessorState;
  }

  public override processEvent(
    args:
      | ProcessEventArgs<CoreProcessorContract>
      | { event: StreamEvent; state: CoreProcessorState },
  ): void {
    switch (args.event.type) {
      case "events.iterate.com/stream/created":
        Promise.resolve(
          this.deps.propagateChildStreamCreated(args.state as CoreProcessorState),
        ).catch((error: unknown) => {
          console.error("core stream processor child propagation failed", error);
        });
        return;
      default:
        return;
    }
  }
}

export function getAncestorStreamPaths(path: string): string[] {
  if (path === "/") return [];
  const segments = path.split("/").filter(Boolean);
  const ancestors = ["/"];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(`/${segments.slice(0, index).join("/")}`);
  }
  return ancestors;
}

export function catchUpCoreProcessorState(args: {
  state: CoreProcessorState;
  events: readonly StreamEvent[];
}): CoreProcessorState {
  let state = args.state;
  for (const event of args.events) {
    if (event.offset <= state.maxOffset) continue;
    const reduction = runProcessorReduce({
      processor: { contract: coreProcessorContract },
      event,
      state,
    });
    if (reduction === undefined) {
      throw new Error(`core processor cannot reduce event type "${event.type}"`);
    }
    state = coreProcessorContract.stateSchema.parse(reduction.state);
  }
  return state;
}

export function reduceCoreProcessorStateFromEvents(
  events: readonly StreamEvent[],
): CoreProcessorState {
  return catchUpCoreProcessorState({
    state: getInitialProcessorState(coreProcessorContract),
    events,
  });
}
