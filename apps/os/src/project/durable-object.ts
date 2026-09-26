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
import {
  acceptGithubCallback,
  confirmGithubMove,
  githubMoveOfferConnectionOf,
} from "../integrations/github.ts";
import {
  connectIntegration,
  disconnectIntegration,
  finishIntegrationConnect,
  type ConnectInput,
  type FinishConnectInput,
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
   *  and the integrations' verbs. `acceptGithubCallback` is GitHub's callback's (integrations/github.ts)
   *  and acts only for its attempt's nonce, which only GitHub's redirect carries;
   *  `finishIntegrationConnect` is not published at all — the platform's callback reaches it
   *  (secret-oauth-callback.ts, through context/built-ins.ts `integrations.finishConnect`). */
  static override publicMethods = [
    ...super.publicMethods,
    "repos",
    "workspaces",
    "connectIntegration",
    "disconnectIntegration",
    "confirmGithubMove",
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

  /** Each connection's integration verbs, one at a time (`#onConnection`): the tail of its chain. */
  readonly #connectionVerbChains = new Map<string, Promise<unknown>>();

  /** ONE INTEGRATION VERB AT A TIME PER CONNECTION: a verb on `provider/connection` starts once the
   *  one before it on that connection settled, and reads the connections caught up through the log
   *  itself (`catchUpFromLog`, not only through the last pushed head: a verb that just appended
   *  `<provider>/connected` may not have been pushed back yet) — so a check and the destructive steps
   *  after it (a moved installation's cleanup) run with no other verb on that connection in between,
   *  such as a reconnect to another account. */
  #onConnection<T>(
    provider: unknown,
    connection: unknown,
    verb: (integrations: ProjectState["integrations"]) => Promise<T>,
  ): Promise<T> {
    const key = `${String(provider)}/${String(connection)}`;
    const previous = this.#connectionVerbChains.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.catchUpFromLog();
      return verb((await this.snapshot()).state.integrations);
    });
    const tail = run.catch(() => {});
    this.#connectionVerbChains.set(key, tail);
    void tail.then(() => {
      if (this.#connectionVerbChains.get(key) === tail) this.#connectionVerbChains.delete(key);
    });
    return run;
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
  connectIntegration(input: ConnectInput): Promise<{ authorizationUrl: string }> {
    return this.#onConnection(input?.provider, input?.connection, (integrations) =>
      connectIntegration(this.#integrationScope(), integrations, input),
    );
  }

  /** The OAuth callback stored a Slack, Google or Cloudflare token: finish the connection — the
   *  callback's alone, not published (context/built-ins.ts `integrations.finishConnect`). */
  finishIntegrationConnect(input: FinishConnectInput): Promise<void> {
    return this.#onConnection(input?.provider, input?.connection, (integrations) =>
      finishIntegrationConnect(this.#integrationScope(), integrations, input),
    );
  }

  /** GitHub sent the human back (integrations/github.ts `githubCallbackRoute`). */
  acceptGithubCallback(input: Parameters<typeof acceptGithubCallback>[1]) {
    return this.#onConnection("github", input?.connection, () =>
      acceptGithubCallback(this.#integrationScope(), {
        ...input,
        connection: assertConnectionName(input?.connection),
      }),
    );
  }

  /** WAITROSE (integrations/waitrose-connection.ts): the username and password are already in
   *  `/secrets/waitrose-<connection>`; record the connection, `waitrose/connected` on `/`. */
  connectWaitrose(input: { connection: string; account: string }): Promise<void> {
    return this.#onConnection("waitrose", input?.connection, () =>
      connectWaitrose(this.#integrationScope(), input),
    );
  }

  /** DISCONNECT: the token revoked where the provider allows, the route and the secret gone, any
   *  connect in flight dropped, `<provider>/disconnected` on `/`. */
  disconnectIntegration(input: {
    provider: IntegrationProvider;
    connection: string;
    movedInstallationId?: string;
  }): Promise<void> {
    return this.#onConnection(input?.provider, input?.connection, (integrations) =>
      disconnectIntegration(this.#integrationScope(), integrations, input),
    );
  }

  /** MOVE A GITHUB INSTALLATION HERE (integrations/github.ts `confirmGithubMove`): the human's
   *  confirmation of the offer GitHub's callback signed, once they proved they administer it. */
  confirmGithubMove(input: { offer: string }): Promise<void> {
    // on the connection the offer names (github.ts verifies the offer itself)
    return this.#onConnection("github", githubMoveOfferConnectionOf(input?.offer), () =>
      confirmGithubMove(this.#integrationScope(), input),
    );
  }
}
