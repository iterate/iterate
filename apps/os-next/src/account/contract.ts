// src/account/contract.ts — THE ACCOUNT: a user's account context (global, `/users/<id>`) records
// authentication FACTS, and THIS FILE is the only place they are spelled. processor.ts folds them into
// the reduced state a client reads through live state — the SAME StreamProcessor kernel every project
// processor uses, no new framework; durable-object.ts is the host (`ctx.exports`, first-party-facets.ts).
// Every type is derived here, never hand-kept:
//   AccountState                        = ProcessorState<typeof AccountContract>  the reduced state below
//   ConsumedEvent<typeof AccountContract>                                          what reduce sees
// No D1: the processor only reduces its own stream. Credentials are NOT here: a personal access token
// is an OAuth grant (grants.ts), listed and ended through `session.grants`, never an account event.
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";

/** `events.iterate.com/account/authenticated` payload (platform FACT, idempotency key
 *  `authenticated/<operationId>`). NO credential material — only which KIND, when, and a stable op id
 *  (dedup on retry). Once the append type-gate is enforced a client cannot forge this type. Hoisted
 *  because it is spelled twice: the event's payload, and the row of the state's list. */
const AuthenticationFact = z.object({
  credential: z.enum(["from-server-cookie", "admin-secret"]),
  at: z.number(),
  operationId: z.string(),
});
export type AuthenticationFact = z.infer<typeof AuthenticationFact>;

export const AccountContract = defineProcessorContract({
  slug: "account",
  version: "1",
  description: "The user's account: authentications.",
  /** THE REDUCED STATE — the user's authentications, in order. The list IS the event it is folded
   *  from — no re-spelling of the payload shape. It is what a client reads through live state. */
  stateSchema: z.object({
    authentications: z.array(AuthenticationFact).default([]),
  }),
  events: {
    "events.iterate.com/account/authenticated": {
      description: "A successful authentication on the user's account (platform fact).",
      payloadSchema: AuthenticationFact,
    },
  },
  consumes: ["events.iterate.com/account/authenticated"],
  emits: [],
});

/** The account's reduced state: the user's authentications (the contract's `stateSchema`). */
export type AccountState = ProcessorState<typeof AccountContract>;
