// src/account/processor.ts — THE ACCOUNT PROCESSOR: the pure reduce of the account's facts into its
// state — the membership facts the control plane lands here (src/control-plane/durable-object.ts)
// among them — and of the user's own secrets' certificates (cross-posted from
// `/users/<id>/secrets/<name>`) into their catalog; the kernel's `ProcessorEngine` drives it and
// projects it to live state, exactly as a project processor. No effect lives here: a PURE FOLD.
// Imports only the pure kernel, so a unit test constructs it with `new` and reduces rows
// (processor.test.ts, in node).
import {
  type ConsumedEvent,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import { reduceSecretCatalog } from "../secret/contract.ts";
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
    if (event.type === "events.iterate.com/account/grant-used") {
      const { grantId, at } = event.payload;
      if ((state.grantUses[grantId]?.at ?? 0) >= at) return undefined; // only forward
      return { ...state, grantUses: { ...state.grantUses, [grantId]: { at } } };
    }
    if (event.type === "events.iterate.com/account/consent-approved")
      return { ...state, consents: [...state.consents, { ...event.payload, at: event.createdAt }] };
    if (event.type === "events.iterate.com/organization/member-added") {
      // The latest role is the row; the first membership's time stays. The same role again is a no-op.
      const { orgId, role } = event.payload;
      const known = state.memberships[orgId];
      if (known?.role === role) return undefined;
      return {
        ...state,
        memberships: {
          ...state.memberships,
          [orgId]: { role, since: known?.since ?? event.createdAt },
        },
      };
    }
    if (event.type === "events.iterate.com/organization/member-removed") {
      if (!state.memberships[event.payload.orgId]) return undefined;
      const { [event.payload.orgId]: _gone, ...memberships } = state.memberships;
      return { ...state, memberships };
    }
    if (
      event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted"
    ) {
      const secrets = reduceSecretCatalog(state.secrets, event);
      return secrets && { ...state, secrets };
    }
    return undefined;
  }
}
