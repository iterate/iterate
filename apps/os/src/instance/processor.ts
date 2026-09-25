// src/instance/processor.ts — THE INSTANCE PROCESSOR: the reduce of the deployment's own secrets'
// certificates (cross-posted from `global:/secrets/<name>`) into their catalog. No effect: a PURE
// FOLD, so a unit test constructs it with `new` and reduces rows (processor.test.ts).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { InstanceContract, type InstanceState } from "./contract.ts";

export class InstanceProcessor extends StreamProcessor<
  InstanceState,
  ConsumedEvent<typeof InstanceContract>
> {
  readonly contract = InstanceContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<InstanceState, ConsumedEvent<typeof InstanceContract>>): InstanceState | undefined {
    const secrets = reduceSecretCatalog(state.secrets, event);
    return secrets && { ...state, secrets };
  }
}
