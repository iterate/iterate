// Implements the project-side "integration" processor (contract.ts).

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { assertNever } from "@iterate-com/streams/shared/stream-processors";
import { IntegrationProcessorContract, type IntegrationProcessorState } from "./contract.ts";
import type { IntegrationEventReceivedPayload } from "~/domains/integrations/integration-events.ts";
export { IntegrationProcessorContract } from "./contract.ts";

export type IntegrationProcessorContract = typeof IntegrationProcessorContract;

export type IntegrationProcessorDeps = {
  /**
   * The fan-out seam: provider-specific reaction to a routed event — spawning
   * an agent thread stream (the Slack-router pattern), poking a repo, etc.
   * Host-supplied so this processor stays provider-agnostic. The spike leaves
   * it unset; events still fold into state and are inspectable on the stream.
   */
  onIntegrationEvent?(input: { payload: IntegrationEventReceivedPayload }): Promise<void> | void;
};

export class IntegrationProcessor extends StreamProcessor<
  IntegrationProcessorContract,
  IntegrationProcessorDeps
> {
  readonly contract = IntegrationProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<IntegrationProcessorContract>["reduce"]>[0],
  ): IntegrationProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/integration/connected":
        return {
          ...state,
          integration: event.payload.integration,
          account: event.payload.account,
          connection: {
            status: "connected",
            ownership: event.payload.ownership,
            externalId: event.payload.externalId,
            ...(event.payload.displayName == null
              ? {}
              : { displayName: event.payload.displayName }),
            routingKeys: event.payload.routingKeys,
            providedSecretSlugs: event.payload.providedSecretSlugs,
          },
        };
      case "events.iterate.com/integration/disconnected":
        return {
          ...state,
          connection: { ...state.connection, status: "disconnected" },
        };
      case "events.iterate.com/integration/event-received":
        return {
          ...state,
          integration: event.payload.integration,
          eventsReceived: state.eventsReceived + 1,
          lastEventAt: event.createdAt,
        };
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<IntegrationProcessorContract>["processEvent"]>[0],
  ): void {
    const { event } = args;
    if (event.type !== "events.iterate.com/integration/event-received") return;
    const payload = event.payload;
    args.runInBackground(async () => {
      await this.deps.onIntegrationEvent?.({ payload });
    });
  }
}
