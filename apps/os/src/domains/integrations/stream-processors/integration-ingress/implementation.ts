// Implements the "integration-ingress" router (contract.ts). The cross-
// namespace hop — global capture stream → project lifecycle stream — is a
// host-supplied dep because stream appends are namespace-local; the processor
// itself stays a pure fold plus a forward decision.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import type { StreamEventInput } from "@iterate-com/streams/shared/event";
import {
  IntegrationIngressProcessorContract,
  type IntegrationIngressProcessorState,
} from "./contract.ts";
export { IntegrationIngressProcessorContract } from "./contract.ts";

export type IntegrationIngressProcessorContract = typeof IntegrationIngressProcessorContract;

export type IntegrationIngressProcessorDeps = {
  /** Append the forwarded event to the claiming account's
   * `{projectId}:/integrations/{slug}/{account}` stream and pre-warm its
   * integration DO. Supplied by the hosting DO. */
  forwardToAccount(input: {
    account: string;
    event: StreamEventInput;
    projectId: string;
  }): Promise<void>;
};

export class IntegrationIngressProcessor extends StreamProcessor<
  IntegrationIngressProcessorContract,
  IntegrationIngressProcessorDeps
> {
  readonly contract = IntegrationIngressProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<IntegrationIngressProcessorContract>["reduce"]>[0],
  ): IntegrationIngressProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/integration/route-registered":
        return {
          ...state,
          integration: event.payload.integration,
          routes: {
            ...state.routes,
            [event.payload.routingKey]: {
              projectId: event.payload.projectId,
              account: event.payload.account,
            },
          },
        };
      case "events.iterate.com/integration/route-removed": {
        const { [event.payload.routingKey]: _removed, ...routes } = state.routes;
        return { ...state, routes };
      }
      case "events.iterate.com/integration/event-received": {
        const routingKey = event.payload.routingKey;
        const unroutable = routingKey == null || state.routes[routingKey] == null;
        return unroutable ? { ...state, dropped: state.dropped + 1 } : state;
      }
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<IntegrationIngressProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    if (event.type !== "events.iterate.com/integration/event-received") return;

    const routingKey = event.payload.routingKey;
    const route = routingKey == null ? undefined : state.routes[routingKey];
    if (route == null) {
      // Unclaimed routing key: captured (durably, upstream of us) but not
      // forwarded. A later route-registered does NOT retroactively forward —
      // claims are forward-looking, like Slack team claims today.
      return;
    }

    const forwarded: StreamEventInput = {
      type: "events.iterate.com/integration/event-received",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: this.contract,
        key: "forward",
        sourceEvent: event,
      }),
      payload: event.payload,
    };
    args.runInBackground(async () => {
      await this.deps.forwardToAccount({ ...route, event: forwarded });
    });
  }
}
