// subscriptions.ts — THE SUBSCRIPTIONS TABLE's one COMMAND. The rows THEMSELVES are `core` state
// (stream/core-processor.ts reduces subscription-configured/-delivery-halted/-delivery-resumed into
// `state.subscriptions`); the READER is the delivery loop (subscription-delivery.ts), which evaluates
// each row's target after every commit and asks the value whether it owns its progress (a facet, a
// lent rpc stub ⇒ push) or not (⇒ the stream keeps a cursor, at-least-once).
//
// A subscription is pure data — a NAME, a TARGET expression whose terminal is callable with
// `(events, range)`, and an optional `consumes` filter. `configured` REPLACES a same-named row; a
// `null` target REMOVES it. The one function here BUILDS that event; the caller appends it. The
// halted fact is appended by the delivery loop; the resumed fact by an operator's plain `itx.append`.

import { print, toItxExpression, type ItxExpressionInput } from "../context/expression.ts";
import { CoreContract, parseSubscriptionName } from "./core-processor.ts";
import type { StreamEventInput } from "./events.ts";

/** The `subscription-configured` event for (or replacing, or with `target: null` removing)
 *  `input.name`. The target must be rooted at `itx`; it is stored PRINTED (the codec round-trips —
 *  expression.test.ts — so what is stored is what the reduce parses). */
export function subscriptionConfiguredEvent(input: {
  name: string;
  target: ItxExpressionInput | null;
  consumes?: string[];
}): StreamEventInput {
  const name = parseSubscriptionName(input.name);
  // A processor's subscription name IS its facet name, and the core reduce's address
  // (`itx.facets.get('core')`) is taken. Refused at the door, never at delivery.
  if (name === CoreContract.slug)
    throw new Error(`"${name}" is the core reduce's name — reserved; pick another`);
  const target = input.target === null ? null : toItxExpression(input.target);
  if (target && target[0] !== "itx")
    throw new Error(
      `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
    );
  return CoreContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name,
      target: target && print(target),
      ...(target && input.consumes && { consumes: input.consumes }),
    },
  });
}
