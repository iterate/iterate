// Implements the "echo-example" processor.
// It appends an output for every input and is intentionally tiny so runtime
// tests can focus on subscription/host behavior instead of business logic.

import { StreamProcessor } from "../../../stream-processor.ts";
import { EchoExampleContract } from "./contract.ts";
export { EchoExampleContract } from "./contract.ts";

export type EchoExampleContract = typeof EchoExampleContract;

export class EchoExampleProcessor extends StreamProcessor<EchoExampleContract> {
  readonly contract = EchoExampleContract;

  protected override reduce(args: Parameters<StreamProcessor<EchoExampleContract>["reduce"]>[0]) {
    if (args.event.type !== "events.iterate.com/echo-example/input-received") return args.state;
    return { seen: args.state.seen + 1 };
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<EchoExampleContract>["processEvent"]>[0],
  ): void {
    if (args.event.type !== "events.iterate.com/echo-example/input-received") return;
    const seen = args.state.seen;
    args.runInBackground(async () => {
      await this.deps.stream.append({
        event: {
          type: "events.iterate.com/echo-example/output-echoed",
          // Replays are deduped by the input's offset, not wall-clock time.
          idempotencyKey: `echo-example/output:${args.event.offset}`,
          payload: { seen },
        },
      });
    });
  }
}
