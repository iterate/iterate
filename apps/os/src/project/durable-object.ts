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
import { runningCause } from "../cause.ts";
import { downloadPublicGithubTemplate } from "../repo/github-template.ts";
import { appConfigOf, type AppConfigEnv } from "../app-config.ts";
import { canBackRepo, projectScopedArtifacts } from "../context/cf-artifacts.ts";
import { moduleIdentityOf } from "../context/worker-loader.ts";
import { CONTEXT_DESTROYED, DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { Env as ContextEnv } from "../iterate-context-durable-object.ts";
import type { IntegrationProvider } from "../integrations/contract.ts";
import {
  assertConnectionName,
  moveOfferConnectionOf,
  type IntegrationScope,
} from "../integrations/connections.ts";
import { acceptGithubCallback } from "../integrations/github.ts";
import {
  confirmIntegrationMove,
  connectIntegration,
  disconnectIntegration,
  finishIntegrationConnect,
  type ConnectInput,
  type FinishConnectAnswer,
  type FinishConnectInput,
} from "../integrations/verbs.ts";
import { EntityCollectionRpcTarget } from "./collection.ts";
import type { ProjectState } from "./contract.ts";
import { cloudflareCustomHostnameProvider, ownershipRecordOf } from "./custom-hostnames.ts";
import { domainConnectLinkOf } from "./domain-connect.ts";
import { dnsZoneOf, txtRecordsOf } from "./dns-provider.ts";
import { ProjectProcessor, type ProjectDeletion, type ProjectHostnames } from "./processor.ts";
import type { ProjectPublisher } from "./publication.ts";

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
   *  and the integrations' verbs a Dash form or a callback calls. `acceptGithubCallback` is GitHub's
   *  callback's (integrations/github.ts) and acts only for its attempt's nonce, which only GitHub's
   *  redirect carries. Connect, finish and disconnect are not published: `itx.integrations`
   *  (context/built-ins.ts) reaches them, and the platform's callback finishes through it
   *  (secret-oauth-callback.ts, `integrations.finishConnect`). */
  static override publicMethods = [
    ...super.publicMethods,
    "repos",
    "workspaces",
    "confirmIntegrationMove",
    "acceptGithubCallback",
  ];

  processor = new ProjectProcessor(
    () => this.getItx(),
    downloadPublicGithubTemplate,
    () => this.#hostnames(),
    () => this.#deletion(),
    () => this.#publisher(),
  );

  /** THE PUBLICATION's reach, for THIS project (publication.ts `ProjectPublisher`): the config
   *  repo's `main` and its files at a commit, a module's identity as the loader resolves it, the
   *  probe loaded as a worker of `/`, and an append on `/` as the platform — the DO's own `invoke`
   *  of the fixed point `append` under `platform: true`, as every platform fact is written
   *  (session.ts, integrations/connections.ts `appendPlatformFact`). */
  #publisher(): ProjectPublisher {
    const root = this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName);
    return {
      // Over the loopback stub a facet call's answer types as an RPC result; the wire copied it.
      head: async () => {
        using itx = this.getItx();
        return (await itx.repos.get("/repos/config").tip()) as unknown as string | null;
      },
      // The repo facet's `modules` answers its files, path → text.
      files: async (commitOid) => {
        using itx = this.getItx();
        return (await itx.repos.get("/repos/config").modules({ commitOid })) as unknown as Record<
          string,
          string
        >;
      },
      identityOf: (files, mainModule) =>
        moduleIdentityOf(files, mainModule, this.env, `the config repo's ${mainModule}`),
      probe: async (files, mainModule) => {
        using itx = this.getItx();
        return await itx.invoke([
          "itx",
          "workers",
          ["get", { source: files, mainModule }],
          ["probe"],
        ]);
      },
      // as the platform, and caused by what the follower reacts to: a publication keeps the
      // commit's depth, so the init it sets off runs one deeper than the commit (../cause.ts)
      appendAsPlatform: (...events) =>
        root.invoke(["itx", "builtins", ["append", ...events]], [], {
          principal: null,
          platform: true,
          cause: runningCause(),
        }),
    };
  }

  /** THE DELETION SAGA's reach, for THIS project (processor.ts `ProjectDeletion`): destroying one of
   *  its contexts, deleting the Artifacts repo a context's path backs, and deleting its kv and
   *  files. The files bucket and the Artifacts binding are absent where a deployment binds none (the
   *  workers tests). */
  #deletion(): ProjectDeletion {
    const { projectId } = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    const artifacts =
      this.env.ARTIFACTS && projectScopedArtifacts({ namespace: this.env.ARTIFACTS, projectId });
    return {
      // the destroyed instance's reset rejects the call that asked for it: that rejection is done.
      // The root only once its row is gone (the verb drops it a moment after it asks for this):
      // destroyed while the row stood, the next request would bear it again, nothing to refuse it
      destroyContext: async (path) => {
        if (path === "/" && !(await new ControlPlane(this.env).deletedProject(projectId)))
          throw new Error(`project ${projectId} still has its row: its root is not destroyed yet`);
        await this.env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path }),
        )
          .destroy()
          .catch((error: unknown) => {
            if (!String(error).includes(CONTEXT_DESTROYED)) throw error;
          });
      },
      // one binding delete by the path's name (cf-artifacts.ts), never the binding's `list`, which
      // pages through every project's repos in the namespace
      deleteRepo: async (path) => {
        if (artifacts && canBackRepo(path)) await artifacts.delete(path);
      },
      deleteProjectStorage: async () => {
        for (let cursor: string | undefined; ;) {
          const page = await this.env.ITX_KV.list({ prefix: `${projectId}:`, cursor });
          await Promise.all(page.keys.map((key) => this.env.ITX_KV.delete(key.name)));
          if (page.list_complete) break;
          cursor = page.cursor;
        }
        for (let cursor: string | undefined; this.env.FILES;) {
          const page = await this.env.FILES.list({ prefix: `${projectId}/`, cursor });
          if (page.objects.length) await this.env.FILES.delete(page.objects.map((o) => o.key));
          if (!page.truncated) break;
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
      reservedZones: config.customHostnames?.reservedZones || [],
      claim: (hostname) => controlPlane.claimHostname(projectId, hostname),
      release: (hostname) => controlPlane.releaseHostname(projectId, hostname),
      heldElsewhere: async (hostname) => {
        const holder = await controlPlane.hostnameHolder(hostname);
        return Boolean(holder) && holder !== projectId;
      },
      proof: async (hostname) => {
        const record = ownershipRecordOf(hostname, projectId);
        const texts = await txtRecordsOf(record.name).catch((caught: unknown): string[] => {
          console.warn(`ownership proof for ${hostname}: ${String(caught)}`);
          return [];
        });
        return { record, proven: texts.includes(record.value) };
      },
      setPrimaryHostname: (hostname) => controlPlane.setPrimaryHostname(projectId, hostname),
      provider: cloudflareCustomHostnameProvider(config),
      // back to the project's Domains page in the dash — addressed by the project's slug, as the
      // dash's routes are — which re-checks the hostname it names
      connect: async (hostname) => {
        const slug = (await controlPlane.getProject(projectId))?.slug;
        return config.domainConnect && config.urls.dash && slug
          ? domainConnectLinkOf(hostname, {
              project: projectId,
              privateKey: config.domainConnect.privateKey.exposeSecret(),
              redirectUri: `${config.urls.dash}/projects/${slug}/domains?connected=${encodeURIComponent(hostname)}`,
            })
          : null;
      },
      dnsZone: (hostname) => dnsZoneOf(hostname),
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
      () => this.getItx(),
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
      getItx: () => this.getItx(),
      storage: this.ctx.storage,
    };
  }

  /** CONNECT (integrations/verbs.ts; `itx.integrations.connect`): where to send a human to consent —
   *  through iterate's app (`client: "iterate"`) or the project's own, whose credentials
   *  `/secrets/<provider>-<connection>` already holds. The provider's callback stores the credential
   *  and finishes the connection, then sends the human to `next` (the platform's or the Dash's
   *  origin). Again for a connection that exists asks for more `scopes` on the same account. */
  connectIntegration(input: ConnectInput): Promise<{ authorizationUrl: string }> {
    return this.#onConnection(input?.provider, input?.connection, (integrations) =>
      connectIntegration(this.#integrationScope(), integrations, input),
    );
  }

  /** The OAuth callback stored a Slack, Google or Cloudflare token: finish the connection — the
   *  callback's alone (context/built-ins.ts `integrations.finishConnect`). */
  finishIntegrationConnect(input: FinishConnectInput): Promise<FinishConnectAnswer> {
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

  /** DISCONNECT (`itx.integrations.disconnect`): the token revoked where the provider allows, the
   *  route and the secret gone, any connect in flight dropped, `<provider>/disconnected` on `/`. */
  disconnectIntegration(input: {
    provider: IntegrationProvider;
    connection: string;
    movedExternalId?: string;
  }): Promise<void> {
    return this.#onConnection(input?.provider, input?.connection, (integrations) =>
      disconnectIntegration(this.#integrationScope(), integrations, input),
    );
  }

  /** MOVE AN ACCOUNT ANOTHER PROJECT HOLDS HERE (integrations/verbs.ts `confirmIntegrationMove`): the
   *  human's confirmation of the offer a provider's callback signed — a GitHub installation they
   *  administer, a Slack workspace Slack let them install into. */
  confirmIntegrationMove(input: { offer: string }): Promise<void> {
    // its steps on the connection the offer names (verbs.ts verifies the offer itself)
    const { provider, connection } = moveOfferConnectionOf(input?.offer);
    return confirmIntegrationMove(this.#integrationScope(), input, (step) =>
      this.#onConnection(provider, connection, step),
    );
  }
}
