// src/account/processor.ts — THE ACCOUNT PROCESSOR: the pure reduce of the authentication facts into
// the account's state; the kernel's `ProcessorEngine` drives it and projects it to live state, exactly
// as a project processor. No effect lives here. Imports only the pure kernel, so a unit test constructs
// it with `new` and reduces rows (processor.test.ts, in node).
import {
  type ConsumedEvent,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import { AccountContract, type AccountState } from "./contract.ts";

export class AccountProcessor extends StreamProcessor<
  AccountState,
  ConsumedEvent<typeof AccountContract>
> {
  readonly contract = AccountContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<AccountState, ConsumedEvent<typeof AccountContract>>): AccountState | undefined {
    if (event.type === "events.iterate.com/account/authenticated")
      return { ...state, authentications: [...state.authentications, event.payload] };
    return undefined;
  }
}
