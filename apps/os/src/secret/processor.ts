// src/secret/processor.ts — THE SECRET PROCESSOR: the pure reduce of a secret's two facts into where
// its material stands. No saga and no effect live here — the value cannot ride an event, so the
// write is a verb (`itx.secrets.set`, context/built-ins.ts) and the facet (durable-object.ts) keeps
// the value; the kernel's `ProcessorEngine` drives this reduce inside that facet and answers it as
// `snapshot()`. Imports only the pure kernel, so a unit test constructs it with `new` and reduces
// rows (processor.test.ts, in node).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { SecretContract, type SecretState } from "./contract.ts";

export class SecretProcessor extends StreamProcessor<
  SecretState,
  ConsumedEvent<typeof SecretContract>
> {
  readonly contract = SecretContract;

  override reduce({
    state,
    event,
  }: ReduceArgs<SecretState, ConsumedEvent<typeof SecretContract>>): SecretState | undefined {
    switch (event.type) {
      case "events.iterate.com/secret/set":
        // Every write is the latest; a set after a deletion brings the secret back.
        return { ...state, material: { offset: event.offset }, deletion: null, borrowed: null };
      case "events.iterate.com/secret/borrowed":
        return {
          material: { offset: event.offset },
          deletion: null,
          borrowed: { lendId: event.payload.lendId },
        };
      case "events.iterate.com/secret/lend-revoked":
        // on the lender's path a lend is not the material; on the borrower's it was all there was
        if (state.borrowed?.lendId !== event.payload.lendId) return undefined;
        return { material: null, deletion: { offset: event.offset }, borrowed: null };
      case "events.iterate.com/secret/deleted":
        // Dies once: a certificate after the certificate is a harmless fact.
        return !state.material && state.deletion
          ? undefined
          : { material: null, deletion: { offset: event.offset }, borrowed: null };
      default:
        return undefined;
    }
  }
}
