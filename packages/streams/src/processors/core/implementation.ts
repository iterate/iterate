// Implements the built-in "core" processor.
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers.

import type { StreamEvent, StreamEventInput } from "../../shared/event.ts";
import type { ConsumedEvent } from "../../shared/stream-processors.ts";
import { StreamProcessor } from "../../stream-processor.ts";
import {
  CoreProcessorContract,
  SupportedSubscriptionConfiguredEvent,
  type CoreProcessorState,
} from "./contract.ts";

export type CoreProcessorContract = typeof CoreProcessorContract;

export class CoreStreamProcessor extends StreamProcessor<CoreProcessorContract> {
  readonly contract = CoreProcessorContract;

  /**
   * Pre-append gate, called by the Durable Object before an event is committed.
   * Core-only: no other processor can reject appends.
   *
   * The pause door is deliberately dumb: any processor can append
   * `stream/paused` / `stream/resumed`, which reduce into `state.paused`, so
   * complicated policies (loop detection, circuit breakers) live in those
   * processors rather than here. Resume/error/woken events pass through a
   * paused stream so it can recover. This is also where append permissions
   * will eventually live, and `stream/paused` may grow more expressive (e.g.
   * blocking only certain events from certain processors).
   */
  validateAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    if (!args.state.paused) return;

    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
        return;
      default:
        throw new Error(`stream paused: ${args.state.pauseReason ?? "unknown reason"}`);
    }
  }

  // The Stream Durable Object runs this processor inline during append with
  // externally-owned state (its own KV/SQL recovery path), so the two methods
  // below take and return state explicitly instead of using the batch/
  // checkpoint lifecycle that ordinary hosted processors get from the base
  // class.

  /** Reduce one committed event against caller-owned state. */
  reduceEvent(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    return this.reduceRawEvent(args)?.state ?? args.state;
  }

  /**
   * Run `processEvent` side effects for one already-reduced event. Inline
   * appends are synchronous, so blocking work is unavailable here — side
   * effects must use `runInBackground` and be idempotent.
   */
  processReducedEvent(args: {
    event: StreamEvent;
    previousState: CoreProcessorState;
    state: CoreProcessorState;
  }): void {
    this.processEvent({
      event: args.event as ConsumedEvent<CoreProcessorContract>,
      previousState: args.previousState,
      state: args.state,
      checkpointOffset: args.event.offset,
      streamMaxOffset: args.event.offset,
      blockProcessorWhile: () => {
        throw new Error(
          "blockProcessorWhile is unavailable when processing a reduced event inline",
        );
      },
      runInBackground: (work) => this.runInBackground(work),
    });
  }

  // The exit parse validates every state transition and applies schema
  // transforms (e.g. dropping unsupported subscription transports).
  override reduce(args: Parameters<StreamProcessor<CoreProcessorContract>["reduce"]>[0]) {
    const state = args.state;
    let next: CoreProcessorState = {
      ...state,
      eventCount: state.eventCount + 1,
      maxOffset: args.event.offset,
    };

    switch (args.event.type) {
      case "events.iterate.com/stream/paused":
        next = {
          ...next,
          paused: true,
          pauseReason: args.event.payload.reason ?? null,
        };
        break;

      case "events.iterate.com/stream/resumed":
        next = {
          ...next,
          paused: false,
          pauseReason: null,
        };
        break;

      case "events.iterate.com/stream/created":
        if (args.event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        next = {
          ...next,
          namespace: args.event.payload.namespace,
          path: args.event.payload.path,
          createdAt: args.event.createdAt,
        };
        break;

      case "events.iterate.com/stream/woken":
        next = {
          ...next,
          incarnationId: args.event.payload.incarnationId,
        };
        break;

      case "events.iterate.com/stream/configured":
        next = {
          ...next,
          config: {
            ...next.config,
            ...args.event.payload.config,
          },
        };
        break;

      case "events.iterate.com/stream/metadata-updated":
        next = {
          ...next,
          metadata: args.event.payload.metadata,
        };
        break;

      case "events.iterate.com/stream/child-stream-created": {
        let childPath: string | null;
        if (args.event.payload.childPath === state.path) {
          childPath = null;
        } else if (state.path === "/") {
          const [firstSegment] = args.event.payload.childPath.split("/").filter(Boolean);
          childPath = firstSegment === undefined ? null : `/${firstSegment}`;
        } else {
          const parentPrefix = `${state.path}/`;
          if (!args.event.payload.childPath.startsWith(parentPrefix)) {
            childPath = null;
          } else {
            const [firstSegment] = args.event.payload.childPath
              .slice(parentPrefix.length)
              .split("/")
              .filter(Boolean);
            childPath = firstSegment === undefined ? null : `${state.path}/${firstSegment}`;
          }
        }

        next =
          childPath === null || next.childPaths.includes(childPath)
            ? next
            : { ...next, childPaths: [...next.childPaths, childPath] };
        break;
      }

      case "events.iterate.com/stream/subscription-configured": {
        const parsed = SupportedSubscriptionConfiguredEvent.safeParse(args.event);
        if (!parsed.success) {
          const { [args.event.payload.subscriptionKey]: _removed, ...subscriptionsByKey } =
            next.subscriptionsByKey;
          next = { ...next, subscriptionsByKey };
          break;
        }
        next = {
          ...next,
          subscriptionsByKey: {
            ...next.subscriptionsByKey,
            [args.event.payload.subscriptionKey]: { latestConfiguredEvent: parsed.data },
          },
        };
        break;
      }

      case "events.iterate.com/stream/processor-registered":
        next = {
          ...next,
          processorsBySlug: {
            ...next.processorsBySlug,
            [args.event.payload.slug]: {
              latestRegisteredEvent: {
                offset: args.event.offset,
                type: args.event.type,
                createdAt: args.event.createdAt,
                payload: {
                  slug: args.event.payload.slug,
                  version: args.event.payload.version,
                  description: args.event.payload.description,
                  consumes: [...args.event.payload.consumes],
                  emits: [...args.event.payload.emits],
                  ownedEvents: args.event.payload.ownedEvents.map((ownedEvent) => ({
                    type: ownedEvent.type,
                    ...(ownedEvent.description === undefined
                      ? {}
                      : { description: ownedEvent.description }),
                    ...(ownedEvent.examples === undefined
                      ? {}
                      : { examples: [...ownedEvent.examples] }),
                  })),
                },
              },
            },
          },
        };
        break;

      default:
        break;
    }
    return this.contract.stateSchema.parse(next);
  }

  // Stream-internal side effects. Today that is one thing: when a stream is
  // created, announce it to every ancestor stream so each maintains its
  // childPaths. The appends are idempotency-keyed and run in the background,
  // so replays and partial failures are safe.
  protected override processEvent(
    args: Parameters<StreamProcessor<CoreProcessorContract>["processEvent"]>[0],
  ): void {
    if (args.event.type !== "events.iterate.com/stream/created") return;
    if (args.state.path === "/") return;

    const pathSegments = args.state.path.split("/").filter(Boolean);
    const ancestorPaths = ["/"];
    for (let index = 1; index < pathSegments.length; index += 1) {
      ancestorPaths.push(`/${pathSegments.slice(0, index).join("/")}`);
    }

    args.runInBackground(async () => {
      await Promise.all(
        ancestorPaths.map((ancestorPath) =>
          this.ctx.stream.append({
            streamPath: ancestorPath,
            event: {
              type: "events.iterate.com/stream/child-stream-created",
              idempotencyKey: `child-stream-created:${ancestorPath}:${args.state.path}`,
              payload: { childPath: args.state.path },
            },
          }),
        ),
      );
    });
  }
}
