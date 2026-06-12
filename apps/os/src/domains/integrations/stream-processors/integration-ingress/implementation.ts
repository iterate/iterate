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
      case "events.iterate.com/integration/route-registered": {
        // FIRST claim wins: a routing key (Slack team, GitHub installation)
        // belongs to exactly one account until route-removed frees it — a
        // later claim by a different owner must not silently steal webhooks.
        // The ONE exception is a consented TAKEOVER (payload.takeover), the
        // outcome of the interstitial "this workspace is connected to
        // project X — really move it?" flow. The losing claim event stays on
        // the journal as evidence either way.
        const existing = state.routes[event.payload.routingKey];
        if (
          existing != null &&
          event.payload.takeover !== true &&
          (existing.projectId !== event.payload.projectId ||
            existing.account !== event.payload.account)
        ) {
          return { ...state, integration: event.payload.integration };
        }
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
      }
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

    if (event.type === "events.iterate.com/integration/route-registered") {
      const claimed = state.routes[event.payload.routingKey];
      if (
        event.payload.takeover !== true &&
        (claimed == null ||
          claimed.projectId !== event.payload.projectId ||
          claimed.account !== event.payload.account)
      ) {
        console.warn("[integration-ingress] routing key already claimed; claim rejected", {
          routingKey: event.payload.routingKey,
          rejected: { projectId: event.payload.projectId, account: event.payload.account },
          owner: claimed,
        });
      }
      return;
    }
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
      // The forwarded copy is the envelope ENRICHED with its routing outcome
      // — account-aware consumers (slack-route's per-account thread paths)
      // read it from here.
      payload: { ...event.payload, account: route.account },
    };
    // BLOCK the checkpoint on the forward: the router's only job is the
    // global → account copy, so an event must not be checkpointed past until
    // its copy landed. A failed forward wedges and replays instead of being
    // logged-and-lost.
    args.blockProcessorWhile(async () => {
      await this.deps.forwardToAccount({ ...route, event: forwarded });
    });
  }
}
