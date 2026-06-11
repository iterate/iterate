// The itx surface: `itx.integrations.{slug}.**` — one loopback capability for
// the whole registry, dialed with platform-injected props (projectId), so
// every integration's well-known SDK hangs off one provided prefix.
//
//   itx.integrations.github.octokit.rest.issues.create({...})
//   itx.integrations.discord.api.channels.createMessage(channelId, {...})
//
// The SDK is constructed HERE, inside a first-party loopback, with material
// dereferenced through the Secret DO's audited trapdoor. Project worker code
// and agents get the SDK's behavior, never its token: this entrypoint is
// platform code, and the path-call boundary only carries arguments and
// serializable results.

import { WorkerEntrypoint } from "cloudflare:workers";
import { replayPathCall, type PathCall } from "~/itx/path-proxy.ts";
import { getIntegration, INTEGRATIONS } from "~/domains/integrations/registry.ts";
import { revealJournaledSecretForPlatformUse } from "~/domains/secrets/secret-streams.ts";

type IntegrationsCapabilityProps = {
  projectId?: string;
};

export class IntegrationsCapability extends WorkerEntrypoint<Env, IntegrationsCapabilityProps> {
  async call(input: PathCall): Promise<unknown> {
    const [slug, ...sdkPath] = input.path;
    if (slug == null) {
      return Object.values(INTEGRATIONS).map((definition) => ({
        slug: definition.slug,
        displayName: definition.displayName,
        instructions: definition.instructions,
      }));
    }
    const definition = getIntegration(slug);
    const projectId = this.ctx.props.projectId;
    if (!projectId) {
      throw new Error("IntegrationsCapability requires dial-injected projectId props.");
    }

    const secretSpecsBySlug = Object.fromEntries(
      definition.providedSecrets.map((spec) => [spec.slug, spec]),
    );
    const sdk = await definition.createSdk({
      projectId,
      getSecretMaterial: async (secretSlug) => {
        return await revealJournaledSecretForPlatformUse({
          projectId,
          slug: secretSlug,
          usedBy: `itx:integrations.${definition.slug}`,
          fallbackEnvVar: secretSpecsBySlug[secretSlug]?.firstPartyEnvFallback,
        });
      },
    });
    return await replayPathCall(sdk, { path: sdkPath, args: input.args });
  }
}
