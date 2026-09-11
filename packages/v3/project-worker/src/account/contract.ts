// src/account/contract.ts — the account context's vocabulary and pure reducer.
//
// A user's account context (global, /users/<id>) records authentication and credential-lifecycle
// FACTS and accepts account COMMANDS; the AccountProcessor folds them into the account VIEW a client
// reads through live state — the SAME StreamProcessor kernel every project processor uses, no new
// framework. This module is the SPEC (the event payload types and the tested pure reducer); the copy
// that runs in a facet is NOT hand-kept — build-sdk.mjs bundles the `AccountProcessor` here (via its
// host ./account-facet.ts) into the loaded `cap.js`, so there is one source. Events are written out
// at their call sites (`itx.append({ type, payload, idempotencyKey })`) — the type string and payload
// are always visible, no builder helpers. No D1: the foundation processor only reduces its own stream,
// so it runs as an ordinary processor; the privileged ctx.exports variant (worker env, D1/OAuth) is
// only for the later token-workflow EFFECTS, and is deferred.
import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ReduceArgs,
  type StreamEvent,
} from "../stream/processor.ts";

// ── the event payloads (facts the platform publishes, commands a client submits) ──

/** Payload of `events.iterate.com/account/authenticated` (a platform-published FACT, idempotency key
 *  `authenticated/<operationId>`). Carries NO credential material — only which KIND of credential,
 *  when, and a stable operation id (dedup on retry). Once the append type-gate is enforced a client
 *  cannot forge this `events.iterate.com/**` type (a control-plane security-spec expected-fail today). */
export type AuthenticationFact = {
  credential: "from-server-cookie" | "admin-secret";
  at: number;
  operationId: string;
};

/** Payload of `events.iterate.com/account/token-create-requested` (a client COMMAND, idempotency key
 *  `token-create/<requestId>`): the client appends it and the processor records it immediately.
 *  INSECURE-FIRST — `value` is stored READABLE (a client string for now; a real minting EFFECT that
 *  stores only a hash follows with the security work). */
export type TokenCreateRequest = {
  requestId: string;
  name: string;
  value: string;
  requestedAt: number;
};

/** Payload of `events.iterate.com/account/token-revoked` (a client COMMAND, idempotency key
 *  `token-revoke/<requestId>`); the processor drops the token from the view. (Real credential
 *  invalidation is the same deferred EFFECT as minting.) */
export type TokenRevoke = { requestId: string };

// ── the view + reducer ──

const AccountView = z.object({
  authentications: z
    .array(z.object({ credential: z.string(), at: z.number(), operationId: z.string() }))
    .default([]),
  tokens: z
    .array(
      z.object({
        requestId: z.string(),
        name: z.string(),
        value: z.string().default(""),
        requestedAt: z.number(),
      }),
    )
    .default([]),
});
/** The account view a client reads (through live state): the user's authentications and tokens. */
export type AccountView = z.infer<typeof AccountView>;

/** The events the AccountProcessor consumes, as a discriminated union — the `Event` param that
 *  narrows `reduce`'s `event.payload` per `event.type` (no cast). Keep in step with the contract's
 *  `consumes`. */
type AccountEvent =
  | (StreamEvent & {
      type: "events.iterate.com/account/authenticated";
      payload: AuthenticationFact;
    })
  | (StreamEvent & {
      type: "events.iterate.com/account/token-create-requested";
      payload: TokenCreateRequest;
    })
  | (StreamEvent & { type: "events.iterate.com/account/token-revoked"; payload: TokenRevoke });

/** Folds account facts and commands into the view. Pure — the kernel's `ProcessorEngine` drives it
 *  and projects it to live state, exactly as it does a project processor; `session.user` hosts it as
 *  a facet, and a client reads it with `useLiveState`. */
export class AccountProcessor extends StreamProcessor<AccountView, AccountEvent> {
  readonly contract = defineProcessorContract({
    slug: "account",
    version: "1",
    description: "The user's account view: authentications and requested tokens.",
    stateSchema: AccountView,
    consumes: [
      "events.iterate.com/account/authenticated",
      "events.iterate.com/account/token-create-requested",
      "events.iterate.com/account/token-revoked",
    ],
    emits: [],
  });

  override reduce({
    event,
    state,
  }: ReduceArgs<AccountView, AccountEvent>): AccountView | undefined {
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
            value: event.payload.value ?? "", // old events (pre-value) reduce to a blank value
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
