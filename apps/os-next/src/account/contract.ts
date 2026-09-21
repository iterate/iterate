// src/account/contract.ts — THE ACCOUNT: a person's context, `/users/<id>` in the deployment-global
// namespace, where the control-plane FACTS about them land — an authentication (session.ts), a
// personal access token minted or a grant ended (grants.ts), a consent approved (consent.ts) — each
// appended by the verb that did it, stamped with the caller. This file is the only place those events
// and their payloads are spelled; processor.ts folds them into the state a client reads through live
// state, durable-object.ts hosts it as the first-party facet `account` (first-party-facets.ts), the
// row enabled where the first fact is published (session.ts `publishGlobalFact`). No D1: the
// processor only reduces its own stream. Credentials are NOT here: a token is an OAuth grant
// (grants.ts), listed and ended through `session.grants`. Every type is derived:
//   AccountState = ProcessorState<typeof AccountContract>   the reduced state below
//   ConsumedEvent<typeof AccountContract>                    what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { SecretContract } from "../secret/contract.ts";

// Each fact's payload is spelled once and used twice — by its event and by the state that keeps it.

/** `events.iterate.com/account/authenticated` (idempotency key `authenticated/<operationId>`): NO
 *  credential material — only which KIND, when, and a stable op id (dedup on retry). Once the append
 *  type-gate is enforced a client cannot forge this type. */
const AuthenticationFact = z.object({
  credential: z.enum(["from-server-cookie", "admin-secret"]),
  at: z.number(),
  operationId: z.string(),
});
export type AuthenticationFact = z.infer<typeof AuthenticationFact>;
/** `events.iterate.com/account/grant-minted`: a personal access token minted through
 *  `session.grants.mint` (grants.ts) — the grant's id, the name given, the projects it reaches. */
export const GrantMinted = z.object({
  grantId: z.string().min(1),
  name: z.string(),
  projects: z.array(z.string()),
  expiresAt: z.number(),
});
export type GrantMinted = z.infer<typeof GrantMinted>;
/** `events.iterate.com/account/grant-ended`: a grant ended — a session logged out, a token revoked
 *  (grants.ts `end` / `endCurrent`). */
export const GrantEnded = z.object({ grantId: z.string().min(1) });
export type GrantEnded = z.infer<typeof GrantEnded>;
/** `events.iterate.com/account/consent-approved`: the person approved a client at consent
 *  (consent.ts): which client, the projects ticked (`null` = every project, current and future)
 *  and the scopes left ticked. The grant's id is not known at approval — the provider mints it
 *  on the code exchange — so the client and the moment are the record. */
export const ConsentApproved = z.object({
  clientId: z.string().min(1),
  clientName: z.string(),
  projects: z.array(z.string()).nullable(),
  scopes: z.array(z.string()),
});
export type ConsentApproved = z.infer<typeof ConsentApproved>;

export const AccountContract = defineProcessorContract({
  slug: "account",
  // 2: the state grew tokens, ended grants and consents (the control-plane facts); 3: `secrets`, the
  // user's own secrets' catalog.
  version: "3",
  description:
    "The user's account: authentications, personal access tokens, ended grants, consents, and the catalog of the user's own secrets.",
  /** THE REDUCED STATE — the record of the account, folded from the facts above: what a client
   *  reads through live state. The lists ARE the events they are folded from — no re-spelling. */
  stateSchema: z.object({
    authentications: z.array(AuthenticationFact).default([]),
    /** Personal access tokens minted, by grant id — and when each was ended. */
    personalAccessTokens: z
      .record(
        z.string(),
        z.object({
          name: z.string(),
          projects: z.array(z.string()),
          expiresAt: z.number(),
          mintedAt: z.string(),
          endedAt: z.string().nullable(),
        }),
      )
      .default({}),
    /** Every grant ended — a session logged out, a token revoked — by grant id: when. */
    endedGrants: z.record(z.string(), z.object({ at: z.string() })).default({}),
    /** Every consent approved, in order: the client and what it was given. */
    consents: z.array(ConsentApproved.extend({ at: z.string() })).default([]),
    /** Every secret set under this owner, by its path (`/secrets/<name>`, what the placeholder
     *  spells; the context lives under this root): the pin, the refresh strategy's kind, and when
     *  it was first set — never a value. What `itx.secrets.list()` reads here. */
    secrets: z
      .record(
        z.string(),
        z.object({
          urls: z.array(z.string()),
          refresh: z.enum(["oauth-refresh-token", "waitrose-session"]).optional(),
          createdAt: z.string(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/account/authenticated": {
      description: "A successful authentication on the user's account (platform fact).",
      payloadSchema: AuthenticationFact,
    },
    "events.iterate.com/account/grant-minted": {
      description: "A personal access token was minted for the account (platform fact).",
      payloadSchema: GrantMinted,
    },
    "events.iterate.com/account/grant-ended": {
      description:
        "A grant of the account ended: a session logged out, a token revoked (platform fact).",
      payloadSchema: GrantEnded,
    },
    "events.iterate.com/account/consent-approved": {
      description: "The person approved a client at consent (platform fact).",
      payloadSchema: ConsentApproved,
    },
  },
  // THE RELATIONSHIP: the account consumes the user's own secrets' certificates without owning them
  // (src/secret/contract.ts: cross-posted from `/users/<id>/secrets/<name>`).
  processorDeps: [SecretContract],
  consumes: [
    "events.iterate.com/account/authenticated",
    "events.iterate.com/account/grant-minted",
    "events.iterate.com/account/grant-ended",
    "events.iterate.com/account/consent-approved",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
  ],
  emits: [],
});

/** The account's reduced state: its record (the contract's `stateSchema`). */
export type AccountState = ProcessorState<typeof AccountContract>;
