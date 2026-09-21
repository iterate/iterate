// src/account/contract.ts — the account context's vocabulary and pure reducer.
//
// A user's account context (global, /users/<id>) records authentication FACTS; the AccountProcessor
// folds them into the account VIEW a client reads through live state — the SAME StreamProcessor
// kernel every project processor uses, no new framework. The contract's `events` map is the
// vocabulary: each type string with its zod payload schema, visible right here. The reduce's event
// union is DERIVED from the contract (`ConsumedEvent`), so there is no hand-kept discriminated union.
// The copy that runs in a facet is NOT hand-kept either — the facet is this worker's own class, the
// `AccountProcessor` (via ./durable-object.ts) into the loaded `cap.js`, one source. No D1: the
// processor only reduces its own stream. Credentials are NOT here: a personal access token is an
// OAuth grant (grants.ts), listed and ended through `session.grants`, never an account event.
import { z } from "zod";
import { defineProcessorContract } from "iterate/next/stream/processor";

// ── event payloads (facts the platform publishes) ──

/** `events.iterate.com/account/authenticated` payload (platform FACT, idempotency key
 *  `authenticated/<operationId>`). NO credential material — only which KIND, when, and a stable op id
 *  (dedup on retry). Once the append type-gate is enforced a client cannot forge this type. */
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

// ── the view ──

export const AccountView = z.object({
  // The list IS the event it is folded from — no re-spelling of the payload shape.
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
});
/** The account view a client reads (through live state): the user's authentications, tokens,
 *  ended grants and consents. */
export type AccountView = z.infer<typeof AccountView>;

// ── the contract + reducer ──

export const AccountContract = defineProcessorContract({
  slug: "account",
  // 2: the view grew tokens, ended grants and consents (the control-plane facts).
  version: "2",
  description:
    "The user's account view: authentications, personal access tokens, ended grants, consents.",
  stateSchema: AccountView,
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
  consumes: [
    "events.iterate.com/account/authenticated",
    "events.iterate.com/account/grant-minted",
    "events.iterate.com/account/grant-ended",
    "events.iterate.com/account/consent-approved",
  ],
  emits: [],
});
