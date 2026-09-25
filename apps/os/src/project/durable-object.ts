// src/project/durable-object.ts — THE PROJECT: the `project` facet on the context at `/`, THE CATALOG
// HOST. It hosts the project processor (processor.ts: the project's own creation saga, its custom
// hostnames, and the catalog folded from the certificates cross-posted to `/`), and THE COLLECTIONS hang off it as methods —
// `repos`, `workspaces` (collection.ts, one instance per entity): each reads the catalog
// from this facet's `snapshot()` for `list()` and runs the entity's creation saga for `create(path)`,
// reached as `itx.repos.list()` / `itx.repos.create(path)` through the library (library.ts, one
// dispatch on this facet: `repos().list()`). And THE INTEGRATIONS (src/integrations/): a project's
// connections to Slack, Google and GitHub, connected and disconnected here and finished here when
// the provider's callback comes back. Hosted from `ctx.exports` (first-party-facets.ts):
// ordinary bundled worker code, enabled as a row on `/` by `session.projects.create` (session.ts) —
// and by the first `list()`, which hosts the facet without a row.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { downloadPublicGithubTemplate } from "../repo/github-template.ts";
import { appConfigOf, type AppConfigEnv } from "../app-config.ts";
import { projectScopedArtifacts } from "../context/cf-artifacts.ts";
import { CONTEXT_DESTROYED, DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { Env as ContextEnv } from "../iterate-context-durable-object.ts";
import type { IntegrationProvider } from "../integrations/contract.ts";
import { assertConnectionName, type IntegrationScope } from "../integrations/connections.ts";
import { acceptGithubCallback } from "../integrations/github.ts";
import {
  connectIntegration,
  disconnectIntegration,
  finishIntegrationConnect,
  type ConnectInput,
} from "../integrations/verbs.ts";
import { connectWaitrose } from "../integrations/waitrose-connection.ts";
import { EntityCollectionRpcTarget } from "./collection.ts";
import type { ProjectState } from "./contract.ts";
import { cloudflareCustomHostnameProvider } from "./custom-hostnames.ts";
import { ProjectProcessor, type ProjectDeletion, type ProjectHostnames } from "./processor.ts";

export class ProjectDurableObject extends StreamProcessorDurableObject<
  ProjectState,
  {
    ITX?: ItxEntrypointService;
    DB: D1Database;
  } & Pick<ContextEnv, "ITERATE_CONTEXT" | "ITX_KV" | "FILES" | "ARTIFACTS"> &
    AppConfigEnv,
  ItxEntrypointScope
> {
  /** The processor's reads, the two collections `itx.repos` / `itx.workspaces` reach (library.ts),
   *  and the integrations' verbs. `finishIntegrationConnect` and `acceptGithubCallback` are the
   *  callbacks' (secret-oauth-callback.ts, integrations/github.ts): the first reports only what the
   *  provider says of a token the project already holds, the second acts only for its attempt's
   *  nonce, which only GitHub's redirect carries. */
  static override publicMethods = [
    ...super.publicMethods,
    "repos",
    "workspaces",
    "connectIntegration",
    "disconnectIntegration",
    "finishIntegrationConnect",
    "connectWaitrose",
    "acceptGithubCallback",
  ];

  processor = new ProjectProcessor(
    (call) => this.withItx(call),
    downloadPublicGithubTemplate,
    () => this.#hostnames(),
    () => this.#deletion(),
  );

  /** THE DELETION SAGA's reach, for THIS project (processor.ts `ProjectDeletion`): destroying one of
   *  its contexts, and deleting its kv, files and Artifacts repos. */
  #deletion(): ProjectDeletion {
    const { projectId } = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    return {
      // the destroyed instance's reset rejects the call that asked for it: that rejection is done
      destroyContext: (path) =>
        this.env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.stringify({ projectId, path }))
          .destroy()
          .catch((error: unknown) => {
            if (!String(error).includes(CONTEXT_DESTROYED)) throw error;
          }),
      deleteProjectStorage: async () => {
        for (let cursor: string | undefined; ;) {
          const page = await this.env.ITX_KV.list({ prefix: `${projectId}:`, cursor });
          await Promise.all(page.keys.map((key) => this.env.ITX_KV.delete(key.name)));
          if (page.list_complete) break;
          cursor = page.cursor;
        }
        // The files bucket and the Artifacts binding are absent where a deployment binds none
        // (the workers tests).
        for (let cursor: string | undefined; this.env.FILES;) {
          const page = await this.env.FILES.list({ prefix: `${projectId}/`, cursor });
          if (page.objects.length) await this.env.FILES.delete(page.objects.map((o) => o.key));
          if (!page.truncated) break;
          cursor = page.cursor;
        }
        if (!this.env.ARTIFACTS) return;
        const artifacts = projectScopedArtifacts({ namespace: this.env.ARTIFACTS, projectId });
        for (let cursor: string | undefined; ;) {
          const page = await artifacts.list({ cursor });
          for (const repo of page.repos) await artifacts.delete(repo.path);
          if (!page.cursor) break;
          cursor = page.cursor;
        }
      },
    };
  }

  /** The custom-hostname effect's reach, for THIS project — built when a request runs, never at
   *  construction: its claims and its primary in the control plane's hostname tables, and
   *  Cloudflare under the deployment's `customHostnames` config. */
  #hostnames(): ProjectHostnames {
    const { projectId } = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    const controlPlane = new ControlPlane(this.env);
    const config = appConfigOf(this.env);
    return {
      reservedZones: config.customHostnames?.reservedZones ?? [],
      claim: (hostname) => controlPlane.claimHostname(projectId, hostname),
      release: (hostname) => controlPlane.releaseHostname(projectId, hostname),
      setPrimaryHostname: (hostname) => controlPlane.setPrimaryHostname(projectId, hostname),
      provider: cloudflareCustomHostnameProvider(config),
    };
  }

  // THE COLLECTIONS are METHODS, not fields: Workers RPC reaches only what the PROTOTYPE declares,
  // and an RpcTarget a METHOD returns is the shape it hands back as a stub — so the library spells
  // `itx.facets.get("project").repos().create(path)`. Each is built once, on first use.
  #collections = new Map<string, EntityCollectionRpcTarget>();
  #collection(slug: "repo" | "workspace"): EntityCollectionRpcTarget {
    const known = this.#collections.get(slug);
    if (known) return known;
    const collection = new EntityCollectionRpcTarget(
      slug,
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
    );
    this.#collections.set(slug, collection);
    return collection;
  }

  /** `itx.repos`: the catalog's repos, and a repo's creation on its path. */
  repos(): EntityCollectionRpcTarget {
    return this.#collection("repo");
  }
  /** `itx.workspaces`: the catalog's workspaces, and a workspace's creation on its path. */
  workspaces(): EntityCollectionRpcTarget {
    return this.#collection("workspace");
  }

  #integrationScope(): IntegrationScope {
    return {
      env: this.env,
      projectId: DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).projectId,
      rootPath: "/",
      withItx: (call) => this.withItx(call),
      storage: this.ctx.storage,
    };
  }

  /** CONNECT (integrations/verbs.ts): where to send a human to consent — through iterate's app
   *  (`client: "iterate"`) or the project's own, whose credentials
   *  `/secrets/<provider>-<connection>` already holds. The provider's callback stores the credential
   *  and finishes the connection, then sends the human to `next` (the platform's or the Dash's
   *  origin). Again for a connection that exists asks for more `scopes` on the same account. */
  async connectIntegration(input: ConnectInput): Promise<{ authorizationUrl: string }> {
    return connectIntegration(this.#integrationScope(), await this.#integrations(), input);
  }

  /** The OAuth callback stored a Slack, Google or Cloudflare token: finish the connection. */
  async finishIntegrationConnect(input: {
    provider: "slack" | "google" | "cloudflare";
    connection: string;
  }): Promise<void> {
    await finishIntegrationConnect(this.#integrationScope(), await this.#integrations(), input);
  }

  /** GitHub sent the human back (integrations/github.ts `githubCallbackRoute`). */
  acceptGithubCallback(input: Parameters<typeof acceptGithubCallback>[1]) {
    return acceptGithubCallback(this.#integrationScope(), {
      ...input,
      connection: assertConnectionName(input?.connection),
    });
  }

  /** WAITROSE (integrations/waitrose-connection.ts): the username and password are already in
   *  `/secrets/waitrose-<connection>`; record the connection, `waitrose/connected` on `/`. */
  async connectWaitrose(input: { connection: string; account: string }): Promise<void> {
    await connectWaitrose(this.#integrationScope(), input);
  }

  /** DISCONNECT: the token revoked where the provider allows, the route and the secret gone, any
   *  connect in flight dropped, `<provider>/disconnected` on `/`. */
  async disconnectIntegration(input: {
    provider: IntegrationProvider;
    connection: string;
  }): Promise<void> {
    await disconnectIntegration(this.#integrationScope(), await this.#integrations(), input);
  }

  async #integrations() {
    return (await this.snapshot()).state.integrations;
  }
}
