// src/account/contract.ts — the account context's vocabulary and pure reducer.
//
// A user's account context (global, /users/<id>) records authentication and credential-lifecycle
// FACTS and accepts account COMMANDS; the AccountProcessor folds them into the account VIEW a client
// reads through live state — the SAME StreamProcessor kernel every project processor uses, no new
// framework. The contract's `events` map is the vocabulary: each type string with its zod payload
// schema, visible right here. The reduce's event union is DERIVED from the contract
// (`ConsumedEvent`), so there is no hand-kept discriminated union. The copy that runs in a facet is
// NOT hand-kept either — build-sdk.mjs bundles the `AccountProcessor` (via ./account-facet.ts) into
// the loaded `cap.js`, one source. No D1: the foundation processor only reduces its own stream; the
// privileged ctx.exports variant (worker env, D1/OAuth) is for the later token EFFECTS, and is deferred.
import { z } from "zod";
import {
  type ConsumedEvent,
  defineProcessorContract,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";

// ── event payloads (facts the platform publishes, commands a client submits) ──

/** `events.iterate.com/account/authenticated` payload (platform FACT, idempotency key
 *  `authenticated/<operationId>`). NO credential material — only which KIND, when, and a stable op id
 *  (dedup on retry). Once the append type-gate is enforced a client cannot forge this type. */
const AuthenticationFact = z.object({
  credential: z.enum(["from-server-cookie", "admin-secret"]),
  at: z.number(),
  operationId: z.string(),
});
export type AuthenticationFact = z.infer<typeof AuthenticationFact>;

/** `events.iterate.com/account/token-create-requested` payload (client COMMAND, idempotency key
 *  `token-create/<requestId>`). INSECURE-FIRST — `value` is stored READABLE (a client string for now;
 *  a real minting EFFECT that stores only a hash follows with the security work). */
const TokenCreateRequest = z.object({
  requestId: z.string(),
  name: z.string(),
  value: z.string(),
  requestedAt: z.number(),
});
export type TokenCreateRequest = z.infer<typeof TokenCreateRequest>;

/** `events.iterate.com/account/token-revoked` payload (client COMMAND, idempotency key
 *  `token-revoke/<requestId>`); the processor drops the token from the view. */
const TokenRevoke = z.object({ requestId: z.string() });
export type TokenRevoke = z.infer<typeof TokenRevoke>;

// ── the view ──

export const AccountView = z.object({
  authentications: z
    .array(z.object({ credential: z.string(), at: z.number(), operationId: z.string() }))
    .default([]),
  tokens: z
    .array(
      z.object({
        requestId: z.string(),
        name: z.string(),
        value: z.string(),
        requestedAt: z.number(),
      }),
    )
    .default([]),
});
/** The account view a client reads (through live state): the user's authentications and tokens. */
export type AccountView = z.infer<typeof AccountView>;

// ── the contract + reducer ──

export const AccountContract = defineProcessorContract({
  slug: "account",
  version: "1",
  description: "The user's account view: authentications and requested tokens.",
  stateSchema: AccountView,
  events: {
    "events.iterate.com/account/authenticated": {
      description: "A successful authentication on the user's account (platform fact).",
      payloadSchema: AuthenticationFact,
    },
    "events.iterate.com/account/token-create-requested": {
      description: "The user asked to create a personal token (client command).",
      payloadSchema: TokenCreateRequest,
    },
    "events.iterate.com/account/token-revoked": {
      description: "The user revoked a token (client command).",
      payloadSchema: TokenRevoke,
    },
  },
  consumes: [
    "events.iterate.com/account/authenticated",
    "events.iterate.com/account/token-create-requested",
    "events.iterate.com/account/token-revoked",
  ],
  emits: [],
});

/** Folds account facts and commands into the view. Pure — the kernel's `ProcessorEngine` drives it
 *  and projects it to live state, exactly as it does a project processor; `session.user` hosts it as
 *  a facet, and a client reads it with `useLiveState`. */
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
      return {
        ...state,
        authentications: [
          ...state.authentications,
          {
            credential: event.payload.credential,
            at: event.payload.at,
            operationId: event.payload.operationId,
          },
        ],
      };
    if (event.type === "events.iterate.com/account/token-create-requested")
      return {
        ...state,
        tokens: [
          ...state.tokens,
          {
            requestId: event.payload.requestId,
            name: event.payload.name,
            value: event.payload.value,
            requestedAt: event.payload.requestedAt,
          },
        ],
      };
    if (event.type === "events.iterate.com/account/token-revoked")
      return {
        ...state,
        tokens: state.tokens.filter((token) => token.requestId !== event.payload.requestId),
      };
    return undefined;
  }
}
