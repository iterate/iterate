// The itx surface: `itx.integrations.{slug}.**` — one loopback capability
// dialed with platform-injected props (projectId), so every integration's
// well-known SDK hangs off one provided prefix.
//
//   itx.integrations.github.octokit.rest.issues.create({...})
//   itx.integrations.discord.api.channels.createMessage(channelId, {...})
//   itx.integrations.waitrose.searchProducts("milk")        ← USERSPACE
//
// Two resolution tiers, same surface:
//
// - Slugs in the platform registry (registry.ts) build their SDK HERE, inside
//   a first-party loopback, with material dereferenced through the Secret
//   DO's audited trapdoor. Agents get the SDK's behavior, never its token.
// - Any other slug is a USERSPACE integration: the call forwards to the
//   project's OWN worker as one method call —
//   `worker.integrations({ slug, path, args })` — and the project's code owns
//   the SDK. Userspace SDKs authenticate with getSecret({ key }) placeholders
//   in bare fetch() headers; the terminal egress pipe substitutes (with
//   inline derivation), so even the project's own integration code never
//   holds its tokens. One method call (not a deep property walk) because
//   workerd RPC does not traverse instance fields.

import { WorkerEntrypoint } from "cloudflare:workers";
import { replayPathCall, type PathCall } from "~/itx/path-proxy.ts";
import { makeDial, resolveDialableTargets } from "~/itx/dial.ts";
import {
  PLATFORM_PROJECT_CONTEXT_ADDRESS,
  PLATFORM_PROJECT_CONTEXT_ID,
  PROJECT_WORKER_SOURCE,
} from "~/itx/platform-context.ts";
import { projectContextAddress } from "~/itx/journal.ts";
import { parseConfig } from "~/config.ts";
import { INTEGRATIONS } from "~/domains/integrations/registry.ts";
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
    const projectId = this.ctx.props.projectId;
    if (!projectId) {
      throw new Error("IntegrationsCapability requires dial-injected projectId props.");
    }

    const definition = INTEGRATIONS[slug];
    if (!definition) {
      return await this.callUserspaceIntegration({
        projectId,
        slug,
        path: sdkPath,
        args: input.args,
      });
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

  /** Forward to the project worker's `integrations({ slug, path, args })`
   * export — the userspace integration convention. */
  private async callUserspaceIntegration(input: {
    projectId: string;
    slug: string;
    path: string[];
    args: unknown[];
  }): Promise<unknown> {
    const dial = makeDial({
      allowlists: resolveDialableTargets(parseConfig(this.env).itx),
      contextAddress: PLATFORM_PROJECT_CONTEXT_ADDRESS,
      contextId: PLATFORM_PROJECT_CONTEXT_ID,
      env: this.env,
      exports: this.ctx.exports as unknown as Parameters<typeof makeDial>[0]["exports"],
      loader: (this.env as { LOADER?: unknown }).LOADER as Parameters<typeof makeDial>[0]["loader"],
      projectId: input.projectId,
    });
    const borrowed = dial(
      { type: "rpc", worker: { type: "source", source: PROJECT_WORKER_SOURCE } },
      {
        capabilityPath: `integrations.${input.slug}`,
        origin: {
          address: projectContextAddress(input.projectId),
          id: input.projectId,
        },
      },
    );
    try {
      return await borrowed.call({
        path: ["integrations"],
        args: [{ slug: input.slug, path: input.path, args: input.args }],
      });
    } finally {
      (borrowed as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }
}
