// The itx surface: `itx.integrations.{slug}.**` — a thin ROUTER, dialed with
// platform-injected props (projectId). It owns no integration logic; it only
// decides which domain object an integration call terminates in:
//
// - Slugs in the platform registry → that integration's OWN Durable Object
//   (IntegrationDurableObject.call), where the SDK is built next to the
//   connection fold and tokens come from the Secret DOs.
// - Any other slug → the project's own worker, as one method call —
//   `worker.integrations({ slug, path, args })` — the USERSPACE convention
//   (one call, not a deep property walk: workerd RPC doesn't traverse
//   instance fields). Userspace SDKs authenticate with getSecret({ key })
//   placeholders in bare fetch() headers, substituted at the terminal egress
//   pipe — so even the project's own integration code never holds tokens.
//
//   itx.integrations.github.octokit.rest.issues.create({...})
//   itx.integrations["google/jonas"].gmail.users.messages.list({...})  ← 2nd ACCOUNT
//   itx.integrations.waitrose.searchProducts("milk")        ← userspace

import { WorkerEntrypoint } from "cloudflare:workers";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { PathCall } from "~/itx/path-proxy.ts";
import { makeDial, resolveDialableTargets } from "~/itx/dial.ts";
import {
  PLATFORM_PROJECT_CONTEXT_ADDRESS,
  PLATFORM_PROJECT_CONTEXT_ID,
  PROJECT_WORKER_SOURCE,
} from "~/itx/platform-context.ts";
import { contextAddress, projectContextRef } from "~/itx/coordinates.ts";
import { parseConfig } from "~/config.ts";
import { INTEGRATIONS } from "~/domains/integrations/registry.ts";
import { DEFAULT_INTEGRATION_ACCOUNT } from "~/domains/integrations/integration-events.ts";
import {
  AmbiguousIntegrationAccountError,
  ensureIntegrationStub,
  resolveImplicitAccount,
} from "~/domains/integrations/durable-objects/integration-durable-object.ts";

type IntegrationsCapabilityProps = {
  projectId?: string;
};

export class IntegrationsCapability extends WorkerEntrypoint<Env, IntegrationsCapabilityProps> {
  async call(input: PathCall): Promise<unknown> {
    const [address, ...sdkPath] = input.path;
    if (address == null) {
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

    // The address under itx.integrations IS the journal path under
    // /integrations: "google/jonas" = /integrations/google/jonas. (Same
    // coordinates, two views: itx.integrations[...] is the account's
    // behavior; the same path through
    // itx.streams.get("/integrations/google/jonas") is its facts.) A BARE
    // slug resolves the implicit account: "default" if present, the sole
    // account otherwise (slack accounts are team-derived).
    const [slug, explicitAccount] = address.split("/", 2) as [string, string?];
    if (INTEGRATIONS[slug]) {
      const account =
        explicitAccount ?? (await resolveImplicitAccount({ projectId, integration: slug }));
      const stub = await ensureIntegrationStub({ account, integration: slug, projectId });
      return await stub.call({ path: sdkPath, args: input.args });
    }
    const account =
      explicitAccount ?? (await this.resolveImplicitUserspaceAccount({ projectId, slug }));
    return await this.callUserspaceIntegration({
      account,
      projectId,
      slug,
      path: sdkPath,
      args: input.args,
    });
  }

  /**
   * Userspace integrations have no IntegrationDurableObject; their accounts
   * are implied by their journaled Secrets (/secrets/{slug}/{account}/{name},
   * the connect convention the Waitrose case establishes). Same resolution
   * rule as registry slugs: "default" if present, the sole account, loud
   * ambiguity otherwise. A slug with no secrets at all resolves "default" —
   * the project worker may not need credentials.
   */
  private async resolveImplicitUserspaceAccount(input: {
    projectId: string;
    slug: string;
  }): Promise<string> {
    const records = await listD1ObjectCatalogRecordsByIndex<{ projectId: string; slug: string }>(
      (this.env as { DO_CATALOG: D1Database }).DO_CATALOG,
      {
        className: "SecretDurableObject",
        indexName: "projectId",
        indexValue: input.projectId,
      },
    );
    const accounts = new Set<string>();
    for (const record of records) {
      const segments = record.structuredName.slug.split("/");
      if (segments.length >= 3 && segments[0] === input.slug) accounts.add(segments[1]!);
    }
    if (accounts.size === 0 || accounts.has(DEFAULT_INTEGRATION_ACCOUNT)) {
      return DEFAULT_INTEGRATION_ACCOUNT;
    }
    if (accounts.size === 1) return [...accounts][0]!;
    throw new AmbiguousIntegrationAccountError({
      integration: input.slug,
      accounts: [...accounts].sort(),
    });
  }

  private async callUserspaceIntegration(input: {
    account: string;
    projectId: string;
    slug: string;
    path: string[];
    args: unknown[];
  }): Promise<unknown> {
    const dial = makeDial({
      allowlists: resolveDialableTargets(parseConfig(this.env).itx),
      contextAddress: PLATFORM_PROJECT_CONTEXT_ADDRESS,
      contextRef: PLATFORM_PROJECT_CONTEXT_ID,
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
          address: contextAddress(projectContextRef(input.projectId)),
          ref: projectContextRef(input.projectId),
        },
      },
    );
    try {
      return await borrowed.call({
        path: ["integrations"],
        args: [{ slug: input.slug, account: input.account, path: input.path, args: input.args }],
      });
    } finally {
      (borrowed as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }
}
