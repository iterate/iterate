// src/account/contract.ts — the account context's vocabulary and pure reducer.
//
// A user's account context (global, /users/<id>) records authentication and, later, credential
// lifecycle FACTS; the AccountProcessor folds them into the account VIEW a client reads through live
// state — the SAME StreamProcessor kernel every project processor uses, no new framework. For the
// foundation the only fact is `account/authenticated`, published best-effort after a successful
// authenticate. It needs no D1, so it runs as an ordinary processor; the privileged ctx.exports
// variant (worker env, D1/OAuth) is only for the later token-workflow effects, and is deferred.
import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ReduceArgs,
  type StreamEventInput,
} from "../stream/processor.ts";

/** A successful authentication, recorded on the user's account context. Carries NO credential
 *  material — only which KIND of credential, when, and a stable operation id (for dedup on retry). */
export const ACCOUNT_AUTHENTICATED = "events.iterate.com/account/authenticated";

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
    type: ACCOUNT_AUTHENTICATED,
    payload: fact,
    idempotencyKey: `authenticated/${fact.operationId}`,
  };
}

const AccountView = z.object({
  authentications: z
    .array(
      z.object({
        credential: z.string(),
        at: z.number(),
        operationId: z.string(),
      }),
    )
    .default([]),
});
/** The account view a client reads (through live state): the user's authentications, newest last. */
export type AccountView = z.infer<typeof AccountView>;

/** Folds account facts into the view. Pure — the kernel's `ProcessorEngine` drives it and projects
 *  it to live state, exactly as it does a project processor; `session.user.facets.get("account")`
 *  hosts it once the platform-owned installation path lands (deferred with the enforcement). */
export class AccountProcessor extends StreamProcessor<AccountView> {
  readonly contract = defineProcessorContract({
    slug: "account",
    version: "1",
    description: "The user's account view: authentications and (later) credential lifecycle.",
    stateSchema: AccountView,
    consumes: [ACCOUNT_AUTHENTICATED],
    emits: [],
  });

  override reduce({ event, state }: ReduceArgs<AccountView>): AccountView | undefined {
    if (event.type !== ACCOUNT_AUTHENTICATED) return undefined;
    const fact = event.payload as AuthenticationFact;
    return {
      authentications: [
        ...state.authentications,
        { credential: fact.credential, at: fact.at, operationId: fact.operationId },
      ],
    };
  }
}
