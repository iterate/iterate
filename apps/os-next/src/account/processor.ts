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
    if (event.type === "events.iterate.com/account/grant-minted") {
      const { grantId, ...token } = event.payload;
      if (state.personalAccessTokens[grantId]) return undefined; // minted once
      // Both facts are published after the fact, in whatever order they land: an end already
      // recorded closes the row as it is born.
      const endedAt = state.endedGrants[grantId]?.at ?? null;
      return {
        ...state,
        personalAccessTokens: {
          ...state.personalAccessTokens,
          [grantId]: { ...token, mintedAt: event.createdAt, endedAt },
        },
      };
    }
    if (event.type === "events.iterate.com/account/grant-ended") {
      const { grantId } = event.payload;
      if (state.endedGrants[grantId]) return undefined; // ended once
      const token = state.personalAccessTokens[grantId];
      return {
        ...state,
        endedGrants: { ...state.endedGrants, [grantId]: { at: event.createdAt } },
        ...(token && {
          personalAccessTokens: {
            ...state.personalAccessTokens,
            [grantId]: { ...token, endedAt: event.createdAt },
          },
        }),
      };
    }
    if (event.type === "events.iterate.com/account/consent-approved")
      return { ...state, consents: [...state.consents, { ...event.payload, at: event.createdAt }] };
    return undefined;
  }
}
