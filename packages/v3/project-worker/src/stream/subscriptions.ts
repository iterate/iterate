// subscriptions.ts — THE SUBSCRIPTIONS TABLE's one COMMAND (the rows are core state; the reader is
// subscription-delivery.ts). A subscription is pure data — a NAME, a TARGET expression whose
// terminal is callable with `(events, range)`, an optional `consumes` filter, and an optional
// `afterOffset` (where the cursor lane starts: 0 = the whole log; absent = from the configure
// offset). `configured` REPLACES a same-named row; a `null` target REMOVES it. The halted fact is
// appended by the delivery loop; the resumed fact by an operator's plain `itx.append`.

import { normalizedItxExpression, print, type ItxExpressionInput } from "../context/expression.ts";
import { parseSubscriptionName } from "./core-processor.ts";
import type { StreamEventInput } from "./events.ts";

/** The `subscription-configured` event for `input.name`. `ifConfiguredAtOffset` (with a null
 *  target) is a handle's undo: the reduce drops the row ONLY while it is still the one configured at
 *  that offset (core-processor.ts). */
export function subscriptionConfiguredEvent(input: {
  name: string;
  target: ItxExpressionInput | null;
  consumes?: string[];
  afterOffset?: number;
  ifConfiguredAtOffset?: number;
}): StreamEventInput {
  const name = parseSubscriptionName(input.name);
  const { afterOffset } = input;
  if (afterOffset !== undefined && !(Number.isInteger(afterOffset) && afterOffset >= 0))
    throw new Error(
      `a subscription's afterOffset is a non-negative integer offset (got ${JSON.stringify(afterOffset)})`,
    );
  // Through the codec's one door, so a target the reduce could not read fails LOUD here, in the
  // parser's words. STORED AS THE PARSED FORM: a target carries a facet's whole source as data, and
  // the reduce must never re-parse that through the string codec (its 2 KiB cap).
  const target = input.target === null ? null : normalizedItxExpression(input.target);
  if (target && target[0] !== "itx")
    throw new Error(
      `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
    );
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name,
      target,
      ...(target && input.consumes && { consumes: input.consumes }),
      ...(target && afterOffset !== undefined && { afterOffset }),
      ...(!target &&
        input.ifConfiguredAtOffset !== undefined && {
          ifConfiguredAtOffset: input.ifConfiguredAtOffset,
        }),
    },
  };
}
