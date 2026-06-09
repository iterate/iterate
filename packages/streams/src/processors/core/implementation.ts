// Implements the built-in "core" processor.
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers.

import type { StreamEventInput } from "../../shared/event.ts";
import { StreamProcessor } from "../../stream-processor.ts";
import {
  CoreProcessorContract,
  SupportedSubscriptionConfiguredEvent,
  type CoreProcessorState,
} from "./contract.ts";

export type CoreProcessorContract = typeof CoreProcessorContract;

export class CoreStreamProcessor extends StreamProcessor<CoreProcessorContract> {
  readonly contract = CoreProcessorContract;

  // This is an extra method that other stream processors don't have that is called straight
  // from the durable object. It lets us reject events before they are appended to the stream.
  //
  // The idea is that we have a single stream/paused event that is used _by any other processor_
  // to tell this stream processor to stop accepting events. That event, alongside its counterparty stream/resumed
  // is reduced into state.paused.
  //
  // That way the complicated
  // loop detection / circuit breaker logic that we will no doubt need can live in other processors.

  // Over time we might make stream/paused more expressive to allow blocking of just certain events from certain
  // processors.
  //
  // This validateAppend method is also where we will implement permissions in the future to ensure not everyone
  // can append every conceivable event to a stream.
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

  public override reduce(args: Parameters<StreamProcessor<CoreProcessorContract>["reduce"]>[0]) {
    const state = this.contract.stateSchema.parse(args.state);
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
    return this.contract.stateSchema.parse(next ?? state);
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<CoreProcessorContract>["processEvent"]>[0],
  ): void {
    switch (args.event.type) {
      case "events.iterate.com/stream/created": {
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
        return;
      }
      default:
        return;
    }
  }
}
