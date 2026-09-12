// src/account/processor.ts — the account processor's PURE class (the triplet's middle: contract.ts is
// the vocabulary, durable-object.ts is the loadable host). Folds account facts and commands into the
// view; the kernel's `ProcessorEngine` drives it and projects it to live state, exactly as a project
// processor. Imports only the pure kernel, so the node lane constructs it with `new` (processor.test.ts).
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";
import { AccountContract, type AccountView } from "./contract.ts";

export class AccountProcessor extends StreamProcessor<
  ProcessorState<typeof AccountContract>,
  ConsumedEvent<typeof AccountContract>
> {
  readonly contract = AccountContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<AccountView, ConsumedEvent<typeof AccountContract>>): AccountView | undefined {
    if (event.type === "events.iterate.com/account/authenticated")
      return { ...state, authentications: [...state.authentications, event.payload] };
    if (event.type === "events.iterate.com/account/token-create-requested")
      return { ...state, tokens: [...state.tokens, event.payload] };
    if (event.type === "events.iterate.com/account/token-revoked")
      return {
        ...state,
        tokens: state.tokens.filter((token) => token.requestId !== event.payload.requestId),
      };
    return undefined;
  }
}
