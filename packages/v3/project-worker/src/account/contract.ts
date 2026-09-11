// src/account/contract.ts — the account context's vocabulary and pure reducer.
//
// A user's account context (global, /users/<id>) records authentication and credential-lifecycle
// FACTS and accepts account COMMANDS; the AccountProcessor folds them into the account VIEW a client
// reads through live state — the SAME StreamProcessor kernel every project processor uses, no new
// framework. This module is the SPEC (the event builders and the tested pure reducer); the copy that
// runs in a facet is NOT hand-kept — build-sdk.mjs bundles the `AccountProcessor` here (via its host
// ./account-facet.ts) into the loaded `cap.js`, so there is one source. No D1: the foundation processor only reduces its own stream, so it
// runs as an ordinary processor; the privileged ctx.exports variant (worker env, D1/OAuth) is only
// for the later token-workflow EFFECTS, and is deferred.
import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ReduceArgs,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/processor.ts";

// ── facts (platform-published) ──

/** A successful authentication, recorded on the user's account context. Carries NO credential
 *  material — only which KIND of credential, when, and a stable operation id (for dedup on retry). */
export type AuthenticationFact = {
  credential: "from-server-cookie" | "admin-secret";
  at: number;
  operationId: string;
};

/** The durable authentication fact, as an appendable event. The PLATFORM publishes it; once the
 *  append type-gate is enforced a client cannot forge this `events.iterate.com/**` type (today that
 *  refusal is one of the control-plane security spec's expected-fails). Idempotent on the operation
 *  id, so a retried publication of the SAME authentication never double-counts. */
export function authenticatedEvent(fact: AuthenticationFact): StreamEventInput {
  return {
    type: "events.iterate.com/account/authenticated",
    payload: fact,
    idempotencyKey: `authenticated/${fact.operationId}`,
  };
}

// ── commands (client-submitted) ──

/** A request to create a personal token — a client COMMAND (not a fact): the client may append it,
 *  and the processor records it in the view immediately. The real credential is minted by the
 *  token-workflow EFFECT (Phase 2); for now the view shows the requested token, which is enough to
 *  prove the live path — the same view later carries the minted value. */
export type TokenCreateRequest = { requestId: string; name: string; requestedAt: number };
export function tokenCreateRequestedEvent(request: {
  requestId: string;
  name: string;
}): StreamEventInput {
  return {
    type: "events.iterate.com/account/token-create-requested",
    payload: { ...request, requestedAt: Date.now() } satisfies TokenCreateRequest,
    idempotencyKey: `token-create/${request.requestId}`,
  };
}

// ── the view + reducer ──

const AccountView = z.object({
  authentications: z
    .array(z.object({ credential: z.string(), at: z.number(), operationId: z.string() }))
    .default([]),
  tokens: z
    .array(z.object({ requestId: z.string(), name: z.string(), requestedAt: z.number() }))
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
    });

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
            requestedAt: event.payload.requestedAt,
          },
        ],
      };
    return undefined;
  }
}
