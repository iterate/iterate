// subscriptions.ts — THE SUBSCRIPTIONS LAYER's reduce: a reduce-only processor hosted INLINE at the
// commit point (beside `core` and `capability-table`), whose reduced state is the subscription table.
// A subscription is pure data — a NAME, a TARGET expression whose terminal is callable with
// `(events, range)`, and an optional `consumes` filter. HOW a subscription is served is never written
// down: the delivery loop (subscription-delivery.ts) evaluates the target and asks the value whether it
// owns its progress (a facet, a live stub ⇒ push) or not (⇒ the stream keeps a cursor, at-least-once).
//
// Four events, apps/os's names. `configured` REPLACES a same-named row (an enablement wants replace,
// where a capability mount wants a shadow stack); `removed` drops it; `delivery-halted` is the FACT the
// delivery loop appends when a cursor target exhausts its retries; `delivery-resumed` is the operator's
// one recovery event — un-halt, optionally seek. Halt/resume are events like pause/resume, not verbs.
//
// Layered on the axioms only: this file knows the stream (append) and the expression codec. It does
// not know facets, stubs, or cursors — those are the layer below and the loop beside it.

import { z } from "zod";
import { createLogger } from "../lib/logs.ts";
import {
  parse,
  print,
  toExpression,
  type Expression,
  type ItxExpression,
} from "../context/expression.ts";
import { defineProcessorContract } from "./events.ts";
import type { ProcessorStream, ReduceArgs, ReduceOnlyProcessor } from "./processor.ts";

const log = createLogger("subscriptions");

/** One segment, [A-Za-z0-9_-]: the facet name for a processor, the registry key's tail for a live callback. */
const SubscriptionName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "a subscription name is one segment: [A-Za-z0-9_-]+");

const SubscriptionsContract = defineProcessorContract({
  slug: "subscriptions",
  version: "1.0.0",
  description:
    "The context's subscriptions: who is sent each committed batch, as pure data — a name, a target expression, an optional consumes filter — plus each cursor target's halt state.",
  stateSchema: z.object({
    subscriptions: z
      .record(
        z.string(),
        z.object({
          /** The target, parsed. The EVENT stores the string. Its terminal is callable with (events, range). */
          target: z.custom<Expression>(() => true),
          /** Event types delivered; absent = every durable event; naming a type opts its ephemerals in. */
          consumes: z.array(z.string()).optional(),
          /** The row's identity — the offset of its subscription-configured event. */
          configuredAtOffset: z.number().int().positive(),
          /** A CURSOR target that exhausted its retries (the loop appended the halted fact). */
          halted: z
            .object({ afterOffset: z.number(), attempts: z.number(), error: z.string().optional() })
            .optional(),
          /** The newest delivery-resumed: the loop applies it once (a seek, an un-halt) and remembers its offset. */
          resumed: z
            .object({ afterOffset: z.number().optional(), atOffset: z.number() })
            .optional(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/stream/subscription-configured": {
      description:
        "Send each committed batch (filtered by `consumes`) to `target`, an itx expression whose terminal is callable with (events, range). Same name REPLACES.",
      payloadSchema: z.object({
        name: SubscriptionName,
        target: z.string(),
        consumes: z.array(z.string()).optional(),
      }),
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Stop: drop the named subscription (and, for a cursor target, its cursor).",
      payloadSchema: z.object({ name: SubscriptionName }),
    },
    "events.iterate.com/stream/subscription-delivery-halted": {
      description:
        "Appended by the delivery loop: a cursor target failed too many times (or with retryable: false); deliveries stop until a delivery-resumed.",
      payloadSchema: z.object({
        name: SubscriptionName,
        afterOffset: z.number().int().nonnegative(),
        attempts: z.number().int().nonnegative(),
        error: z.string().optional(),
      }),
    },
    "events.iterate.com/stream/subscription-delivery-resumed": {
      description:
        "The operator's recovery: un-halt the named cursor subscription, optionally seeking its cursor to `afterOffset` first.",
      payloadSchema: z.object({
        name: SubscriptionName,
        afterOffset: z.number().int().nonnegative().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
  ],
  emits: [
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/subscription-delivery-halted",
  ],
});

export type SubscriptionsState = z.infer<typeof SubscriptionsContract.stateSchema>;
export type Subscription = SubscriptionsState["subscriptions"][string];

/** The subscriptions table as a REDUCE-ONLY processor: the pure reduce, plus the two doors that
 *  append (`configure` / `remove`), both idempotent against the CURRENT state so a reconnect or a
 *  repeated call appends nothing. The halted fact is appended by the delivery loop; the resumed
 *  fact by an operator's plain `itx.append`. */
export class SubscriptionsProcessor implements ReduceOnlyProcessor<SubscriptionsState> {
  readonly contract = SubscriptionsContract;
  readonly #stream: ProcessorStream;
  /** Names a subscription may not take — the host's own facet names (a processor's subscription
   *  name IS its facet name, and `core` / `capability-table` / `subscriptions` are the inline
   *  reduces' addresses). Refused at the door, never at delivery time. */
  readonly #reservedNames: ReadonlySet<string>;

  constructor(stream: ProcessorStream, reservedNames: Iterable<string> = []) {
    this.#stream = stream;
    this.#reservedNames = new Set(reservedNames);
  }

  reduce({ event, state }: ReduceArgs<SubscriptionsState>): SubscriptionsState | undefined {
    if (event.ephemeral) return undefined;
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "events.iterate.com/stream/subscription-configured": {
        let target: Expression;
        try {
          target = parse(p.target as string);
        } catch (error) {
          // One bad hand-appended event must not wedge every later commit: skip it, loudly.
          log.warn("skipping malformed subscription-configured", { offset: event.offset, error });
          return undefined;
        }
        const consumes = p.consumes as string[] | undefined;
        return {
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              target,
              ...(consumes && { consumes }),
              configuredAtOffset: event.offset,
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-removed": {
        if (!((p.name as string) in state.subscriptions)) return undefined;
        const { [p.name as string]: _gone, ...rest } = state.subscriptions;
        return { subscriptions: rest };
      }
      case "events.iterate.com/stream/subscription-delivery-halted": {
        const row = state.subscriptions[p.name as string];
        if (!row) return undefined;
        return {
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              ...row,
              halted: {
                afterOffset: p.afterOffset as number,
                attempts: p.attempts as number,
                ...(p.error !== undefined && { error: p.error as string }),
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-resumed": {
        const row = state.subscriptions[p.name as string];
        if (!row) return undefined;
        const { halted: _cleared, ...kept } = row;
        return {
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              ...kept,
              resumed: {
                ...(p.afterOffset !== undefined && { afterOffset: p.afterOffset as number }),
                atOffset: event.offset,
              },
            },
          },
        };
      }
      default:
        return undefined;
    }
  }

  /** Configure (or replace) a subscription: append the event — unless the CURRENT row is already
   *  exactly this (same target, same filter, not halted), in which case nothing is appended and the
   *  existing identity comes back. That door idempotence is what makes a reconnecting client's
   *  re-subscribe ZERO events. The target must be rooted at `itx` and round-trip the codec (what
   *  we store is what the reduce will parse). */
  async configure(
    state: SubscriptionsState,
    input: { name: string; target: ItxExpression; consumes?: string[] },
  ): Promise<{ name: string; configuredAtOffset: number }> {
    const name = SubscriptionName.parse(input.name);
    if (this.#reservedNames.has(name))
      throw new Error(`"${name}" is an inline reduce's name — reserved; pick another`);
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
      );
    const targetString = print(target);
    if (print(parse(targetString)) !== targetString)
      throw new Error(
        `subscription target ${JSON.stringify(targetString)} does not round-trip the codec`,
      );
    const consumes = input.consumes && [...input.consumes];
    const current = state.subscriptions[name];
    if (
      current &&
      !current.halted &&
      print(current.target) === targetString &&
      JSON.stringify(current.consumes ?? null) === JSON.stringify(consumes ?? null)
    )
      return { name, configuredAtOffset: current.configuredAtOffset };
    const [event] = await this.#stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name, target: targetString, ...(consumes && { consumes }) },
      }),
    );
    return { name, configuredAtOffset: event.offset };
  }

  /** Remove a subscription: append the event, unless there is nothing to remove. */
  async remove(state: SubscriptionsState, name: string): Promise<void> {
    if (!(SubscriptionName.parse(name) in state.subscriptions)) return;
    await this.#stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/stream/subscription-removed",
        payload: { name },
      }),
    );
  }
}
