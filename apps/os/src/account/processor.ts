// src/account/processor.ts — THE ACCOUNT PROCESSOR: the pure reduce of the account's facts into its
// state — the membership facts the session lands here (session.ts `foldPlatformFacts`, after the
// control-plane database writes them) among them — and of the user's own secrets' certificates (cross-posted from
// `/users/<id>/secrets/<name>`) into their catalog; the kernel's `ProcessorEngine` drives it and
// projects it to live state, exactly as a project processor. No effect lives here: a PURE FOLD.
// Imports only the pure kernel, so a unit test constructs it with `new` and reduces rows
// (processor.test.ts, in node).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { dropMembership, reduceMembership } from "../organization/contract.ts";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { reduceIntegrations } from "../integrations/contract.ts";
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
    // Every fact folded here is the platform's to write (`source.platform`, caller.ts
    // `Caller.platform`): the person can append any type to their own context, and that one stays on
    // the log, attributed to them, and changes nothing.
    if (event.source?.platform !== true) return undefined;
    switch (event.type) {
      case "events.iterate.com/account/authenticated":
        return { ...state, authentications: [...state.authentications, event.payload] };
      case "events.iterate.com/account/personal-access-token-minted": {
        const { id, ...key } = event.payload;
        if (state.personalAccessTokens[id]) return undefined; // minted once
        // An end already recorded under the id closes the key as it is born.
        const endedAt = state.endedGrants[id]?.at ?? null;
        return {
          ...state,
          personalAccessTokens: {
            ...state.personalAccessTokens,
            [id]: { ...key, mintedAt: event.createdAt, endedAt },
          },
        };
      }
      case "events.iterate.com/account/grant-ended": {
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
      case "events.iterate.com/account/grant-used": {
        const { grantId, at } = event.payload;
        if ((state.grantUses[grantId]?.at ?? 0) >= at) return undefined; // only forward
        return { ...state, grantUses: { ...state.grantUses, [grantId]: { at } } };
      }
      case "events.iterate.com/account/consent-approved":
        return {
          ...state,
          consents: [...state.consents, { ...event.payload, at: event.createdAt }],
        };
      case "events.iterate.com/organization/member-added": {
        const { orgId, role, mint } = event.payload;
        // A MINT is the organization's first membership, landed here in the background once the
        // creation that minted it answered (session.ts `landProjectOnOrganization`). Any other
        // membership fact of the organization is later than it, even one that lands first, so a
        // mint never overrides a membership the account holds, nor revives one that ended.
        if (mint && (state.memberships[orgId] || state.endedMemberships[orgId])) return undefined;
        const memberships = reduceMembership(state.memberships, orgId, role, event.createdAt);
        if (!memberships) return undefined;
        const { [orgId]: _rejoined, ...endedMemberships } = state.endedMemberships;
        return { ...state, memberships, endedMemberships };
      }
      case "events.iterate.com/organization/member-removed": {
        // the end is kept even for a membership the account never held: its mint may land after it
        const { orgId } = event.payload;
        return {
          ...state,
          memberships: dropMembership(state.memberships, orgId) ?? state.memberships,
          endedMemberships: { ...state.endedMemberships, [orgId]: { at: event.createdAt } },
        };
      }
      case "events.iterate.com/secret/set":
      case "events.iterate.com/secret/deleted":
      case "events.iterate.com/secret/lent":
      case "events.iterate.com/secret/lend-revoked": {
        const secrets = reduceSecretCatalog(state.secrets, event);
        return secrets && { ...state, secrets };
      }
      case "events.iterate.com/google/connected":
      case "events.iterate.com/google/disconnected":
      case "events.iterate.com/cloudflare/connected":
      case "events.iterate.com/cloudflare/disconnected":
      case "events.iterate.com/github/connected":
      case "events.iterate.com/github/disconnected":
      case "events.iterate.com/waitrose/connected":
      case "events.iterate.com/waitrose/disconnected": {
        const integrations = reduceIntegrations(state.integrations, event);
        return integrations && { ...state, integrations };
      }
      default:
        return undefined;
    }
  }
}
