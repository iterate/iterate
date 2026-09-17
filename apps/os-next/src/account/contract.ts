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

// ── the view ──

export const AccountView = z.object({
  // The list IS the event it is folded from — no re-spelling of the payload shape.
  authentications: z.array(AuthenticationFact).default([]),
});
/** The account view a client reads (through live state): the user's authentications. */
export type AccountView = z.infer<typeof AccountView>;

// ── the contract + reducer ──

export const AccountContract = defineProcessorContract({
  slug: "account",
  version: "1",
  description: "The user's account view: authentications.",
  stateSchema: AccountView,
  events: {
    "events.iterate.com/account/authenticated": {
      description: "A successful authentication on the user's account (platform fact).",
      payloadSchema: AuthenticationFact,
    },
  },
  consumes: ["events.iterate.com/account/authenticated"],
  emits: [],
});
