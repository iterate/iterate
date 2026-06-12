// Implements the account-side "integration" processor (contract.ts) — where
// the integration's LOGIC lives. The Durable Object is the host: it folds
// this processor and supplies the two cross-boundary deps the processor
// can't reach itself (the GLOBAL-namespace routing stream, waking sibling
// Secret hosts). Everything else — the connect choreography, the fold, the
// fan-out seam — is processor code.
//
// Connecting an account is ONE event: `integration/connect-requested`
// carries everything (encrypted credentials, routing keys, identity), and
// THIS processor reacts with the choreography:
//
//   1. each credential  → `secret/set` cross-posted to /secrets/{slug}/{account}/{name}
//   2. the account      → `integration/connected` on its own stream
//   3. each routing key → claimed on the global capture stream (host dep)
//
// Every append is idempotency-keyed from the source event, so replays after
// a re-handshake dedupe instead of double-connecting.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import { IntegrationProcessorContract, type IntegrationProcessorState } from "./contract.ts";
import type { IntegrationEventReceivedPayload } from "~/domains/integrations/integration-events.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import { secretStreamPath } from "~/domains/secrets/stream-processors/secret/contract.ts";
export { IntegrationProcessorContract } from "./contract.ts";

export type IntegrationProcessorContract = typeof IntegrationProcessorContract;

export type IntegrationProcessorDeps = {
  /** Claim a routing key on the GLOBAL capture stream — cross-namespace, so
   * the host supplies it (stream appends are namespace-local). */
  claimRoute?(input: { routingKey: string }): Promise<void>;
  /** Wake a Secret's domain object so its subscription lands on the freshly
   * created /secrets/... stream. */
  ensureSecretHost?(input: { slug: string }): Promise<void>;
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
      case "events.iterate.com/integration/connect-requested":
        return state;
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

    if (event.type === "events.iterate.com/integration/connect-requested") {
      const payload = event.payload;
      // Block the processor: the connected fact must fold before later
      // events (and a connect caller waiting on catch-up) proceed.
      args.blockProcessorWhile(async () => {
        // 1. Credentials become Secrets — cross-path appends inside the
        //    project namespace; each Secret's own processor takes it from
        //    there (encryption already happened at the edge).
        const providedSecretSlugs: string[] = [];
        for (const { name, ...secret } of payload.secrets) {
          const slug = providedSecretSlug({
            integration: payload.integration,
            account: payload.account,
            name,
          });
          providedSecretSlugs.push(slug);
          await this.ctx.stream.append({
            streamPath: secretStreamPath(slug),
            event: {
              type: "events.iterate.com/secret/set",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: this.contract,
                key: `connect-secret-${name}`,
                sourceEvent: event,
              }),
              payload: {
                slug,
                ...secret,
                source: {
                  kind: "integration-connect",
                  integration: payload.integration,
                  account: payload.account,
                },
              },
            },
          });
          await this.deps.ensureSecretHost?.({ slug });
        }

        // 2. The connected fact, on this account's own stream.
        await this.ctx.stream.append({
          event: {
            type: "events.iterate.com/integration/connected",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: this.contract,
              key: "connected",
              sourceEvent: event,
            }),
            payload: {
              integration: payload.integration,
              account: payload.account,
              projectId: payload.projectId,
              ownership: payload.ownership,
              externalId: payload.externalId,
              ...(payload.displayName == null ? {} : { displayName: payload.displayName }),
              routingKeys: payload.routingKeys,
              providedSecretSlugs,
            },
          },
        });

        // 3. Routing-key claims on the global capture stream.
        for (const routingKey of payload.routingKeys) {
          await this.deps.claimRoute?.({ routingKey });
        }
      });
      return;
    }

    if (event.type !== "events.iterate.com/integration/event-received") return;
    const payload = event.payload;
    args.runInBackground(async () => {
      await this.deps.onIntegrationEvent?.({ payload });
    });
  }
}
