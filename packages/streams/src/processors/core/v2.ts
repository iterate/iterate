import type { StreamEventInput } from "../../shared/event.ts";
import { StreamProcessor, type ProcessEventArgs } from "../../stream-processor-v2.ts";
import { assertStreamAppendAllowed } from "./implementation.ts";
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

  beforeAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    assertStreamAppendAllowed({
      event: args.event,
      state: args.state,
    });
  }

  protected override processEvent(args: ProcessEventArgs<CoreProcessorContract>): void {
    if (args.event.type !== "events.iterate.com/stream/created") return;

    args.runInBackground(async () => {
      await this.deps.propagateChildStreamCreated(args.state as CoreProcessorState);
    });
  }
}
