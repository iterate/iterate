// Implements the built-in "core" processor.
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers.

import type { StreamEvent, StreamEventInput } from "../../shared/event.ts";
import { StreamProcessor, type ProcessEventArgs } from "../../stream-processor.ts";
import {
  CoreProcessorContract,
  SupportedSubscriptionConfiguredEvent,
  type CoreProcessorState,
} from "./contract.ts";

export type CoreProcessorContract = typeof CoreProcessorContract;
type CoreEvent = StreamEvent<string, any>;

export class CoreStreamProcessor extends StreamProcessor<CoreProcessorContract> {
  readonly contract = CoreProcessorContract;

  validateAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    if (!args.state.paused) return;

    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
        return;
      default:
        throw new Error(`stream paused: ${args.state.pauseReason ?? "circuit breaker open"}`);
    }
  }

  public override reduce(args: {
    event: CoreEvent;
    state: CoreProcessorState;
  }): CoreProcessorState {
    let next: CoreProcessorState = {
      ...args.state,
      eventCount: args.state.eventCount + 1,
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
        if (args.event.payload.childPath === args.state.path) {
          childPath = null;
        } else if (args.state.path === "/") {
          const [firstSegment] = args.event.payload.childPath.split("/").filter(Boolean);
          childPath = firstSegment === undefined ? null : `/${firstSegment}`;
        } else {
          const parentPrefix = `${args.state.path}/`;
          if (!args.event.payload.childPath.startsWith(parentPrefix)) {
            childPath = null;
          } else {
            const [firstSegment] = args.event.payload.childPath
              .slice(parentPrefix.length)
              .split("/")
              .filter(Boolean);
            childPath = firstSegment === undefined ? null : `${args.state.path}/${firstSegment}`;
          }
        }

        next =
          childPath === null || next.childPaths.includes(childPath)
            ? next
            : { ...next, childPaths: [...next.childPaths, childPath] };
        break;
      }

      case "events.iterate.com/stream/subscription-configured":
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

      case "events.iterate.com/stream/processor-registered":
        next = {
          ...next,
          processorsBySlug: {
            ...next.processorsBySlug,
            [args.event.payload.slug]: { latestRegisteredEvent: args.event },
          },
        };
        break;

      default:
        break;
    }
    return this.contract.stateSchema.parse(next ?? args.state);
  }

  protected override processEvent(args: ProcessEventArgs<CoreProcessorContract>): void {
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
