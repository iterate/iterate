// The Project Durable Object: the durable home of one PROJECT CONTEXT
// (apps/os/docs/itx-spec.md). It has exactly three jobs:
//
// 1. ITX REGISTRY SUPERVISOR — it embeds the capability registry and is the
//    dispatch point for every capability invocation in this project.
//
// 2. WORKER SOURCE-OF-TRUTH — it owns the build pipeline for the project's
//    worker (durable-objects/worker.ts) and answers "what is the current
//    worker code?". It does NOT serve ingress: project-host requests are
//    dispatched by the stateless ProjectIngressEntrypoint, which loads the
//    worker itself and only asks this DO for the checkout.
//
// 3. EGRESS AUTHORITY — `egressFetch` is the project's one pipe to the
//    outside world (Law 5): secret placeholder substitution, the egress
//    intercept tunnel, and (future) human-in-the-loop approval live here.
//    Calling `fetch` on the project worker gets the project's homepage;
//    calling `fetch` on the project gets egress — matching itx vocabulary,
//    where `itx.fetch` IS project egress.
//
// State lives in the project's root event stream, projected by
// ProjectProcessor (stream-processors/project-processor.ts); creation is
// event-sourced (create-requested → created → … → create-completed). The
// DO's own SQLite holds only the itx registry's capability table; the worker
// checkout cache is plain DO storage. There is no bespoke project table.
//
// Endgame for egress (out of scope here): a stateless egress capability with
// policy cached outside the DO, consulting the DO only for secrets and
// approvals — and the captun intercept tunnel replaced by a live
// egress-shadowing capability provided over capnweb-with-WebSockets
// (github.com/iterate/capnweb): a connected client `provide`s a fetch stub
// that shadows default egress instead of holding a bespoke tunnel.

import { env } from "cloudflare:workers";
import { z } from "zod";
import { acceptCaptunTunnel, type Fetcher } from "captun";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import { jsonataReactorEventTypes } from "~/domains/agents/stream-processors/jsonata-reactor/contract.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { parseConfig } from "~/config.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";
import {
  AGENTS_STREAM_PATH,
  type AgentDurableObject,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { normalizeIngressHost } from "~/ingress/host-routing.ts";
import {
  PROJECT_CREATE_REQUESTED_EVENT_TYPE,
  PROJECT_STREAM_PATH,
  ProjectProcessor,
  ProjectProcessorContract,
  type ProjectFacts,
} from "~/domains/projects/stream-processors/project-processor.ts";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import {
  bundleWorkerCode,
  cloneWorkerRepo,
  readLoopbackExports,
  WorkerHost,
  type LoadedWorkerEntrypoint,
  type WorkerCheckout,
  type WorkerCode,
  type WorkerLoaderBinding,
  type WorkerWorkspace,
} from "~/domains/projects/durable-objects/worker.ts";
import {
  type RepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { ensureIterateConfigInfoForProject } from "~/domains/repos/entrypoints/repo-capability.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
  EXAMPLE_EGRESS_SECRET_METADATA,
} from "~/domains/secrets/example-secret.ts";
import { ContextRegistry, durableObjectFacetsHook, type LiveCapTarget } from "~/itx/registry.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import { ITX_AUDIT_STREAM_PATH } from "~/itx/protocol.ts";
import type {
  CapInvoke,
  CapMeta,
  CapSource,
  PathCall,
  SerializableCapTarget,
} from "~/itx/protocol.ts";

type CaptunServerTunnel = Fetcher & Disposable;

export type ProjectStructuredName = {
  projectId: string;
};

const ProjectStructuredName = z.object({
  projectId: z.string(),
});

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export function getProjectDurableObjectName(projectId: string) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId },
  });
}

/**
 * Mint a Project DO stub. Lives here (a trusted domain DO file) so ingress code
 * never accesses the raw PROJECT binding — see the
 * no-raw-durable-object-binding-access lint rule.
 */
export function getProjectDurableObjectStub(projectId: string) {
  return env.PROJECT.getByName(getProjectDurableObjectName(projectId));
}

export type ProjectSummary = {
  id: string;
  slug: string;
  defaultHost: string;
  hosts: string[];
};

export type CreateProjectInput = {
  projectId: string;
  slug: string;
};

type ProjectEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  APP_CONFIG: string;
  DB: D1Database;
  DO_CATALOG: D1Database;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type ProjectRuntimeEnv = {
  LOADER: WorkerLoaderBinding;
  WORKSPACE: DurableObjectNamespace;
};

const ProjectDurableObjectBase = createIterateDurableObjectBase<
  typeof ProjectStructuredName,
  Pick<ProjectEnv, "DO_CATALOG">
>({
  className: "ProjectDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
  },
  nameSchema: ProjectStructuredName,
});

export class ProjectDurableObject extends ProjectDurableObjectBase<ProjectEnv> {
  // ---- processor: the project's durable state ----------------------------
  //
  // The root stream ("/") is the record; ProjectProcessor projects it into
  // the snapshot this DO reads back. Side effects of creation run inside the
  // processor through the `creation` deps below.

  host = createStreamProcessorHost(this.ctx);
  workerHost = new WorkerHost({
    ctx: this.ctx,
    loader: projectRuntimeEnv(this.env).LOADER,
    workspaceNamespace: projectRuntimeEnv(this.env).WORKSPACE,
    getRepo: (project) =>
      ensureIterateConfigInfoForProject({
        env: this.env,
        projectId: project.id,
        projectSlug: project.slug,
      }),
    cloneRepo: (input) => this.cloneWorkerRepo(input),
    bundle: (files) => this.bundleWorkerCode(files),
  });
  projectProcessor = this.host.add(
    ProjectProcessorContract.slug,
    (deps) =>
      new ProjectProcessor({
        ...deps,
        creation: {
          summarize: (input) => this.summarizeProject(input),
          ensureExampleEgressSecret: ({ projectId }) => this.ensureExampleEgressSecret(projectId),
          ensureAgentsRoot: ({ projectId }) => this.ensureAgentsRoot(projectId),
          writeAgentsRootRule: ({ projectId }) => this.writeAgentsRootRule(projectId),
          buildWorker: async (project) => {
            const checkout = await this.workerHost.buildFresh({
              id: project.projectId,
              slug: project.slug,
            });
            return {
              commitOid: checkout.commitOid,
              mainModule: checkout.workerCode.mainModule,
            };
          },
        },
        forwardEventToWorker: (event) => this.forwardEventToWorker(event),
      }),
  );

  #projectEgressInterceptTunnel: CaptunServerTunnel | null = null;

  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureProjectSubscription(params.projectId);
    });
  }

  /** Subscription callables on the project's root stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  /** The ProjectProcessor's checkpoint: `{ offset, state }`. */
  async getProjectState() {
    await this.ensureStarted();
    return await this.projectProcessor.snapshot();
  }

  // ---- identity & creation ------------------------------------------------
  //
  // Projects are intentionally ownerless at their core. Organization
  // membership is an access grant in D1, not a property of this DO, because
  // agents can create unclaimed projects that a user or organization claims
  // later, similar to Stripe sandboxes.

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    await this.initialize({
      name: getProjectDurableObjectName(input.projectId),
    });
    await this.ensureStarted();

    // The D1 projection lands before the event: platform-host routing
    // resolves hosts from the projects table, so the row must exist before
    // the first ingress request or custom-hostname update.
    await upsertProjectProjection({ db: this.env.DB, input });

    const facts = this.summarizeProject(input);
    const stream = await this.projectStream(input.projectId);
    await stream.append({
      type: PROJECT_CREATE_REQUESTED_EVENT_TYPE,
      idempotencyKey: `project-create-requested:${input.projectId}`,
      payload: { projectId: input.projectId, slug: input.slug },
    });

    // The creation steps — example secret, agents root, the created/
    // create-completed events — run in ProjectProcessor. Wait for them so a
    // project is BORN with its guarantees (e.g. itx.fetch right after create
    // finds the example secret); only the worker build stays async.
    await this.waitForCreateCompleted(input.projectId);
    return toSummary(facts);
  }

  private async waitForCreateCompleted(projectId: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snapshot = await this.projectProcessor.snapshot();
      if (snapshot.state.phase === "ready") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(`[ProjectDO] createProject(${projectId}) returning before create-completed.`);
  }

  async getSummary(): Promise<ProjectSummary> {
    await this.ensureStarted();
    return await this.requireSummary();
  }

  async describe(): Promise<ProjectSummary & { ingressUrl: string }> {
    await this.ensureStarted();
    return {
      ...(await this.requireSummary()),
      ingressUrl: await this.ingressUrl(),
    };
  }

  async ingressUrl(): Promise<string> {
    await this.ensureStarted();
    const summary = await this.requireSummary();
    const config = this.getAppConfig();
    const row = await this.env.DB.prepare(`SELECT custom_hostname FROM projects WHERE id = ?`)
      .bind(summary.id)
      .first<{ custom_hostname: string | null }>();
    const host = row?.custom_hostname?.trim().toLowerCase() || summary.defaultHost;
    const protocol = config.baseUrl ? new URL(config.baseUrl).protocol : "https:";
    return new URL(`${protocol}//${host}`).origin;
  }

  // ---- itx capability registry (apps/os/docs/itx-spec.md §4) --------------
  //
  // The Project DO hosts the PROJECT CONTEXT: it embeds the registry and is
  // the supervisor for every capability invocation in this project. These
  // five methods are the entire registry surface; itx handles (src/itx/) call
  // them over Workers RPC and never reach the registry any other way.

  #itxRegistry: ContextRegistry | null = null;

  async itxProvide(input: {
    name: string;
    target: LiveCapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    await this.ensureStarted();
    return this.itxRegistry().provide(input);
  }

  async itxDefine(input: {
    name: string;
    target?: SerializableCapTarget;
    source?: CapSource;
    kind?: "worker" | "facet";
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    await this.ensureStarted();
    return this.itxRegistry().define(input);
  }

  async itxRevoke(input: { name: string }) {
    await this.ensureStarted();
    return this.itxRegistry().revoke(input);
  }

  async itxDescribe() {
    await this.ensureStarted();
    return this.itxRegistry().describe();
  }

  async itxInvoke(input: PathCall & { name: string }) {
    await this.ensureStarted();
    return await this.itxRegistry().invoke(input.name, { args: input.args, path: input.path });
  }

  private itxRegistry(): ContextRegistry {
    if (this.#itxRegistry) return this.#itxRegistry;
    const projectId = this.structuredName.projectId;
    this.#itxRegistry = new ContextRegistry({
      // Best-effort audit trail on the project's /itx stream; the registry's
      // SQLite table is the authoritative state (itx DECISIONS.md D1).
      audit: (event) => {
        this.ctx.waitUntil(
          (async () => {
            const stream = await getInitializedStreamStub({
              durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
              namespace: projectId,
              path: StreamPath.parse(ITX_AUDIT_STREAM_PATH),
            });
            await stream.append({ payload: event.payload, type: event.type });
          })().catch((error) => {
            console.error(`[itx] audit append failed for ${projectId}:`, error);
          }),
        );
      },
      // Gated on DIALABLE_BINDINGS inside the registry before this is called.
      binding: (name) => (this.env as unknown as Record<string, unknown>)[name],
      contextId: projectId,
      facets: durableObjectFacetsHook(this.ctx),
      loader: projectRuntimeEnv(this.env).LOADER as unknown as ConstructorParameters<
        typeof ContextRegistry
      >[0]["loader"],
      loopback: (exportName, options) => {
        const exports = this.ctx.exports as unknown as Record<
          string,
          (options: Record<string, unknown>) => unknown
        >;
        const factory = exports[exportName];
        if (typeof factory !== "function") {
          throw new Error(`Loopback export ${exportName} is not available.`);
        }
        return factory(options);
      },
      projectId,
      sql: this.getDurableObjectSql(),
    });
    return this.#itxRegistry;
  }

  // ---- the worker ----------------------------------------------------------
  //
  // Ingress dispatch happens in the stateless ProjectIngressEntrypoint; these
  // methods are how it (and itx.worker) reach the worker's source of truth.

  /**
   * The current worker version, with dispatch semantics: serves the cached
   * checkout while fresh, kicks off ONE background rebuild when stale, and
   * reports "building" only when nothing is cached yet.
   */
  async getWorkerVersion(): Promise<
    | { status: "ready"; commitOid: string; summary: ProjectSummary }
    | { status: "building"; summary: ProjectSummary }
  > {
    await this.ensureStarted();
    const summary = await this.requireSummary();
    const version = await this.workerHost.versionForDispatch(summary);
    if (version.status === "ready") {
      return { status: "ready", commitOid: version.checkout.commitOid, summary };
    }
    return { status: "building", summary };
  }

  /**
   * The current checkout (commit + worker code). Loader miss callbacks fetch
   * this lazily, so the code payload only crosses RPC on a cold isolate.
   */
  async getWorkerCheckout(): Promise<WorkerCheckout> {
    await this.ensureStarted();
    const summary = await this.requireSummary();
    return (
      (await this.workerHost.getCachedCheckout()) ?? (await this.workerHost.buildFresh(summary))
    );
  }

  /**
   * `itx.worker.foo(...)`: replay a path call against the worker entrypoint.
   * The entrypoint itself can never cross an RPC boundary (workerd forbids
   * transferring loader entrypoints), so the call replays HERE — every public
   * method/getter on the worker's default export is reachable with no wiring.
   * Builds fresh so tool calls always see the latest pushed config.
   */
  async callWorkerFunction(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    await this.ensureStarted();
    const summary = await this.requireSummary();
    const checkout = await this.workerHost.buildFresh(summary);
    const entrypoint = this.workerHost.load({ checkout, projectId: summary.id });
    return await replayPathCall(entrypoint, { args: input.args ?? [], path: input.path });
  }

  /** Best-effort delivery of live root-stream events to the worker's hook. */
  private async forwardEventToWorker(event: StreamEvent) {
    try {
      if (!(await this.workerHost.isReady())) return;
      const summary = await this.currentSummary();
      if (!summary) return;
      const checkout = await this.workerHost.getCachedCheckout();
      if (!checkout) return;
      const entrypoint = this.workerHost.load({ checkout, projectId: summary.id });
      await entrypoint.processEvent?.({
        event: event as unknown as Parameters<
          NonNullable<LoadedWorkerEntrypoint["processEvent"]>
        >[0]["event"],
      });
    } catch (error) {
      console.error("Project worker processEvent failed.", error);
    }
  }

  protected async cloneWorkerRepo(input: WorkerWorkspace & { repo: RepoInfo }) {
    await cloneWorkerRepo(input);
  }

  protected async bundleWorkerCode(files: Record<string, string>): Promise<WorkerCode> {
    return await bundleWorkerCode(files);
  }

  // ---- egress --------------------------------------------------------------

  /**
   * `fetch` on the project IS egress (the worker's `fetch` is the homepage).
   * The one exception is the egress intercept tunnel's WebSocket handshake,
   * which must ride the fetch path — upgrades cannot cross RPC methods.
   */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__iterate/intercept-project-egress") {
      return this.acceptProjectEgressInterceptTunnel(request);
    }
    return await this.egressFetch(request);
  }

  async egressFetch(request: Request): Promise<Response> {
    if (!isHttpRequestUrl(request.url)) {
      return await fetch(request);
    }

    await this.ensureStarted();
    const secrets = getSecretsCapability({
      exports: readLoopbackExports(this.ctx.exports),
      props: { projectId: this.structuredName.projectId },
    });

    // Use one request-level intercept decision for both secret substitution and
    // routing so a newly connected tunnel cannot see real secret material.
    const egressInterceptTunnel = this.#projectEgressInterceptTunnel;
    const [secretSubstitutionError, substitutedHeaders] =
      await substituteProjectEgressSecretHeaders({
        headers: request.headers,
        projectEgressInterceptActive: !!egressInterceptTunnel,
        secrets,
      });
    if (secretSubstitutionError) return secretSubstitutionError;

    const outboundHeaders = new Headers(request.headers);
    for (const [header, value] of Object.entries(substitutedHeaders)) {
      outboundHeaders.set(header, value);
    }
    const outboundRequest = new Request(request, { headers: outboundHeaders });

    if (egressInterceptTunnel) {
      return await egressInterceptTunnel.fetch(outboundRequest);
    }

    return await fetch(outboundRequest);
  }

  private acceptProjectEgressInterceptTunnel(request: Request): Response {
    const expectedToken = this.getAppConfig().adminApiSecret?.exposeSecret();
    if (!expectedToken) {
      return Response.json(
        { error: "Project Egress Intercept Tunnel is disabled." },
        { status: 404 },
      );
    }

    if (
      !authenticateAdminBearer({
        authorizationHeader: request.headers.get("authorization"),
        config: this.getAppConfig(),
      })
    ) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "Project Egress Intercept Tunnel requires a WebSocket upgrade." },
        { status: 400 },
      );
    }

    const { response, tunnel } = acceptCaptunTunnel({
      onDisconnect: () => {
        if (this.#projectEgressInterceptTunnel === tunnel) {
          this.#projectEgressInterceptTunnel = null;
        }
      },
    });

    this.replaceProjectEgressInterceptTunnel(tunnel);
    return response;
  }

  protected replaceProjectEgressInterceptTunnel(tunnel: CaptunServerTunnel) {
    if (this.#projectEgressInterceptTunnel) {
      console.warn("Replacing active Project Egress Intercept Tunnel.");
      this.#projectEgressInterceptTunnel[Symbol.dispose]();
    }
    this.#projectEgressInterceptTunnel = tunnel;
  }

  // ---- creation steps (called by ProjectProcessor) -------------------------

  /** Pure: the project's hosts derive entirely from (projectId, slug, config). */
  private summarizeProject(input: { projectId: string; slug: string }): ProjectFacts {
    const config = this.getAppConfig();
    const hosts = projectHosts({
      bases: config.projectHostnameBases,
      projectId: input.projectId,
      slug: input.slug,
    });
    return {
      defaultHost: hosts.defaultHost,
      hosts: hosts.projectHosts,
      projectId: input.projectId,
      slug: input.slug,
    };
  }

  private async ensureExampleEgressSecret(projectId: string) {
    const secrets = getSecretsCapability({
      exports: readLoopbackExports(this.ctx.exports),
      props: { projectId },
    });

    const existing = await secrets.getSecretSummaryByKeyOrNull({
      key: EXAMPLE_EGRESS_SECRET_KEY,
    });
    if (existing) return;

    await secrets.setSecret({
      key: EXAMPLE_EGRESS_SECRET_KEY,
      material: EXAMPLE_EGRESS_SECRET_MATERIAL,
      metadata: EXAMPLE_EGRESS_SECRET_METADATA,
    });
  }

  private async ensureAgentsRoot(projectId: string) {
    await getInitializedDoStub({
      allowCreate: true,
      namespace: this.env.AGENT,
      name: getAgentDurableObjectName({
        agentPath: AGENTS_STREAM_PATH,
        projectId,
      }),
    });
  }

  private async writeAgentsRootRule(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: AGENTS_STREAM_PATH,
    });

    await stream.append({
      type: jsonataReactorEventTypes.ruleConfigured,
      idempotencyKey: `agents-child-stream-setup:${projectId}`,
      payload: {
        slug: "agents-child-stream-setup",
        matcher: "type = 'events.iterate.com/stream/child-stream-created'",
        reactions: [],
      },
    });
  }

  // ---- plumbing ------------------------------------------------------------

  private async requireSummary(): Promise<ProjectSummary> {
    const summary = await this.currentSummary();
    if (!summary) throw new Error("Project has not been created yet.");
    return summary;
  }

  private async currentSummary(): Promise<ProjectSummary | null> {
    const snapshot = await this.projectProcessor.snapshot();
    if (snapshot.state.project) return toSummary(snapshot.state.project);

    // Cold path: the snapshot can lag the create-requested append by a beat.
    // The D1 projection is written synchronously in createProject and hosts
    // derive purely from (projectId, slug, config), so reconstruct from D1.
    const projectId = this.structuredName.projectId;
    const row = await this.env.DB.prepare(`SELECT slug FROM projects WHERE id = ?`)
      .bind(projectId)
      .first<{ slug: string }>();
    if (!row) return null;
    return toSummary(this.summarizeProject({ projectId, slug: row.slug }));
  }

  private async projectStream(projectId: string) {
    return await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: PROJECT_STREAM_PATH,
    });
  }

  private async ensureProjectSubscription(projectId: string) {
    const stream = await this.projectStream(projectId);
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `project-subscription:${projectId}:project-processor`,
      payload: {
        subscriptionKey: `project:${projectId}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "PROJECT",
          durableObjectName: getProjectDurableObjectName(projectId),
          processorName: ProjectProcessorContract.slug,
        }),
      },
    });
  }

  private getAppConfig() {
    return parseConfig(this.env);
  }
}

function toSummary(facts: ProjectFacts): ProjectSummary {
  return {
    id: facts.projectId,
    slug: facts.slug,
    defaultHost: facts.defaultHost,
    hosts: facts.hosts,
  };
}

async function upsertProjectProjection(input: { db: D1Database; input: CreateProjectInput }) {
  const row = await input.db
    .prepare(
      `INSERT INTO projects (id, slug, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(input.input.projectId, input.input.slug)
    .first<{ id: string }>();

  if (!row) throw new Error(`Project ${input.input.projectId} projection was not written.`);
}

export function projectHosts(input: { bases: readonly string[]; projectId: string; slug: string }) {
  const hosts = input.bases.flatMap((base) => [
    normalizeIngressHost(`${input.slug}.${base}`),
    normalizeIngressHost(`${input.projectId}.${base}`),
  ]);
  return {
    defaultHost: normalizeIngressHost(`${input.slug}.${input.bases[0] ?? "iterate.localhost"}`),
    projectHosts: hosts,
  };
}

function isHttpRequestUrl(urlString: string) {
  const url = new URL(urlString);
  return url.protocol === "http:" || url.protocol === "https:";
}

function projectRuntimeEnv(env: ProjectEnv): ProjectRuntimeEnv {
  return env as unknown as ProjectRuntimeEnv;
}
