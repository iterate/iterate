// src/account/contract.ts — THE ACCOUNT: a person's context, `/users/<id>` in the deployment-global
// namespace, where the FACTS about them land — an authentication (session.ts), a personal access
// token minted, a grant ended or used (grants.ts, oauth.ts), a consent approved (consent.ts) — each
// appended by the verb that did it, stamped with the caller; and the memberships the session lands
// here after the control-plane database writes them (session.ts `foldPlatformFacts`).
// This file is the only place its own events and their payloads are spelled; processor.ts folds
// them into the state a client reads through live state (the dash's tree: which organizations a
// person belongs to is THIS fold, bounded per person); durable-object.ts hosts it as the
// first-party facet `account` (first-party-facets.ts), the row enabled where the first fact is
// published. A PURE FOLD: no effect lives here. Credentials are NOT here: a token is an OAuth grant
// (grants.ts), listed and ended through `session.grants`; whether a grant is revoked IS read here
// (`endedGrants`, oauth.ts) — the account is the truth of its own grants' ends. Every type is
// derived:
//   AccountState = ProcessorState<typeof AccountContract>   the reduced state below
//   ConsumedEvent<typeof AccountContract>                    what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { OrganizationContract, OrganizationRole } from "../organization/contract.ts";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

// Each fact's payload is spelled once and used twice — by its event and by the state that keeps it.

/** `events.iterate.com/account/authenticated` (idempotency key `authenticated/<operationId>`): NO
 *  credential material — only which KIND, when, and a stable op id (dedup on retry). A client can
 *  append this type to its own account, but only the platform's is stamped `source.platform`, and
 *  the account processor folds nothing else (processor.ts). */
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
 *  (grants.ts `end` / `endCurrent`). AWAITED by the verb: from this fact on, every admission of the
 *  grant is refused (oauth.ts reads `endedGrants`). */
export const GrantEnded = z.object({ grantId: z.string().min(1) });
export type GrantEnded = z.infer<typeof GrantEnded>;
/** `events.iterate.com/account/grant-used`: the grant was presented — at most once an hour per
 *  grant per isolate (oauth.ts `recordGrantUse`), so the log stays a summary; what the sessions
 *  page shows as "last used". */
export const GrantUsed = z.object({ grantId: z.string().min(1), at: z.number() });
export type GrantUsed = z.infer<typeof GrantUsed>;
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
  // A checkpoint reduced under an older version is reused as-is by the engine, so bumping the version
  // is what re-reduces every existing root log.
  version: "4",
  description:
    "The user's account: authentications, personal access tokens, ended and used grants, consents, the organizations the person belongs to, and the catalog of the user's own secrets.",
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
    /** Every grant ended — a session logged out, a token revoked — by grant id: when. THE
     *  REVOCATION TRUTH: oauth.ts refuses a grant found here on every admission. */
    endedGrants: z.record(z.string(), z.object({ at: z.string() })).default({}),
    /** When each grant was last seen in use, by grant id (the sessions page's "last used"). */
    grantUses: z.record(z.string(), z.object({ at: z.number() })).default({}),
    /** Every consent approved, in order: the client and what it was given. */
    consents: z.array(ConsentApproved.extend({ at: z.string() })).default([]),
    /** The organizations the person belongs to, by organization id: the role, and since when.
     *  Bounded per person — what the dash's tree hangs off, and what a reach check reads. */
    memberships: z
      .record(z.string(), z.object({ role: OrganizationRole, since: z.string() }))
      .default({}),
    /** Every secret set under this owner (src/secret/contract.ts): what `itx.secrets.list()` reads here. */
    secrets: SecretCatalog.default({}),
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
    "events.iterate.com/account/grant-used": {
      description:
        "A grant of the account was presented (platform fact, at most hourly per grant).",
      payloadSchema: GrantUsed,
    },
    "events.iterate.com/account/consent-approved": {
      description: "The person approved a client at consent (platform fact).",
      payloadSchema: ConsentApproved,
    },
  },
  // THE RELATIONSHIPS: the account consumes the user's own secrets' certificates without owning
  // them (src/secret/contract.ts: cross-posted from `/users/<id>/secrets/<name>`), and the
  // organization's membership facts (src/organization/contract.ts: landed here by the session
  // beside the organization's own log, after the control-plane database writes the membership).
  processorDeps: [SecretContract, OrganizationContract],
  consumes: [
    "events.iterate.com/account/authenticated",
    "events.iterate.com/account/grant-minted",
    "events.iterate.com/account/grant-ended",
    "events.iterate.com/account/grant-used",
    "events.iterate.com/account/consent-approved",
    "events.iterate.com/organization/member-added",
    "events.iterate.com/organization/member-removed",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
  ],
  emits: [],
});

/** The account's reduced state: its record (the contract's `stateSchema`). */
export type AccountState = ProcessorState<typeof AccountContract>;
