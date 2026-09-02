// subscriptions.ts — THE SUBSCRIPTIONS TABLE's two COMMANDS. The rows THEMSELVES are `core` state
// (stream/core-processor.ts reduces subscription-configured/-removed/-delivery-halted/-delivery-resumed
// into `state.subscriptions`); the READER is the delivery loop (subscription-delivery.ts), which
// evaluates each row's target after every commit and asks the value whether it owns its progress (a
// facet, a live stub ⇒ push) or not (⇒ the stream keeps a cursor, at-least-once).
//
// A subscription is pure data — a NAME, a TARGET expression whose terminal is callable with
// `(events, range)`, and an optional `consumes` filter. `configured` REPLACES a same-named row (an
// enablement wants replace, where a capability mount wants a shadow stack); `removed` drops it. The
// two functions here BUILD those events — idempotent against the current rows, so a reconnecting
// client's re-subscribe or a repeated remove appends NOTHING; the caller appends what comes back. The
// halted fact is appended by the delivery loop; the resumed fact by an operator's plain `itx.append`.

import { print, toExpression, type ItxExpression } from "../context/expression.ts";
import { CoreContract, SubscriptionName, type Subscription } from "./core-processor.ts";
import type { StreamEventInput } from "./events.ts";

/** The `subscription-configured` event for (or replacing) `input.name` — or `null` when the CURRENT
 *  row is already exactly this (same target, same filter, not halted): nothing to append, the
 *  existing identity stands. The target must be rooted at `itx`; it is stored PRINTED (the codec
 *  round-trips — expression.test.ts — so what is stored is what the reduce parses). */
export function subscriptionConfiguredEvent(
  rows: Readonly<Record<string, Subscription>>,
  input: { name: string; target: ItxExpression; consumes?: string[] },
): StreamEventInput | null {
  const name = SubscriptionName.parse(input.name);
  // A processor's subscription name IS its facet name, and the core reduce's address
  // (`itx.facets.get('core')`) is taken. Refused at the door, never at delivery.
  if (name === CoreContract.slug)
    throw new Error(`"${name}" is the core reduce's name — reserved; pick another`);
  const target = toExpression(input.target);
  if (target[0] !== "itx")
    throw new Error(
      `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
    );
  const targetString = print(target);
  const current = rows[name];
  if (
    current &&
    !current.halted &&
    print(current.target) === targetString &&
    JSON.stringify(current.consumes ?? null) === JSON.stringify(input.consumes ?? null)
  )
    return null;
  return CoreContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name, target: targetString, ...(input.consumes && { consumes: input.consumes }) },
  });
}

/** The `subscription-removed` event for a live row — or `null` when there is nothing to remove. */
export function subscriptionRemovedEvent(
  rows: Readonly<Record<string, Subscription>>,
  name: string,
): StreamEventInput | null {
  if (!(SubscriptionName.parse(name) in rows)) return null;
  return CoreContract.buildEvent({
    type: "events.iterate.com/stream/subscription-removed",
    payload: { name },
  });
}
