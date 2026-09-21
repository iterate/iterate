// src/account/processor.ts — the account processor's PURE class (the triplet's middle: contract.ts is
// the vocabulary, durable-object.ts is the loadable host). Folds account facts into the view; the
// kernel's `ProcessorEngine` drives it and projects it to live state, exactly as a project
// processor. Imports only the pure kernel, so the node lane constructs it with `new` (processor.test.ts).
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
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
