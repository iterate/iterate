import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { CapabilityProvisionRpcTarget } from "../../rpc-targets.ts";
import { LiveCapabilityProviderChannel, type LiveProvideInput } from "./live-capability-relay.ts";

/**
 * Stateless owner of one multiplexed session/CapabilityHost provider channel.
 * This is the ordinary-Worker termination point Kenton sketches before the
 * short, demand-driven Workers RPC leg into the Durable Object:
 * https://github.com/cloudflare/capnweb/issues/36#issuecomment-3334955335
 *
 * Kenton's capnweb#36 architecture terminates Cap'n Web here, in an ordinary
 * Worker, and uses Workers RPC for the short hop into the Durable Object. The
 * returned provision target keeps this execution context (and the caller's
 * provider export) alive. On Workers Standard this stateless leg is charged
 * by requests and CPU time, not Durable Object GB-s duration; the deployed
 * account's pricing model remains authoritative:
 * https://developers.cloudflare.com/workers/platform/pricing/
 * https://developers.cloudflare.com/durable-objects/platform/pricing/
 * The CapabilityHost DO retains no provider stub while idle; `wake`
 * temporarily reconstructs that hop for actual demand.
 */
export class LiveCapabilityRelayEntrypoint extends WorkerEntrypoint<
  Env,
  { path: string; projectId: string }
> {
  #channel: LiveCapabilityProviderChannel | undefined;

  async provide(input: LiveProvideInput): Promise<CapabilityProvisionRpcTarget> {
    let channel = this.#channel;
    if (channel === undefined || !channel.acceptsProviders) {
      channel = new LiveCapabilityProviderChannel({
        env: this.env,
        scope: this.ctx.props,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      });
      this.#channel = channel;
    }
    const provision = await channel.provide(input);
    return new CapabilityProvisionRpcTarget({
      ctx: this.ctx,
      isActive: provision.isActive,
      path: provision.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: provision.revoke,
    });
  }
}
