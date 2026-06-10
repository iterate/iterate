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
// ProjectProcessor (stream-processors/project-processor.ts), which also owns
// every creation side effect — including the one D1 `projects` projection.
// The DO's own SQLite holds only the itx registry's capability table; the
// worker checkout cache is plain DO storage. There is no bespoke project
// table and no lifecycle mixin: the DO is addressed by the plain project id.
//
// Endgame for egress (itx-next.md §9, out of scope here): a stateless egress
// capability with policy cached outside the DO, and the captun intercept
// tunnel replaced by a live egress-shadowing capability provided over
// capnweb-with-WebSockets.

import { DurableObject, env } from "cloudflare:workers";
import { acceptCaptunTunnel, type Fetcher } from "captun";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { parseConfig } from "~/config.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import {
  PROJECT_STREAM_PATH,
  projectFacts,
  ProjectProcessorContract,
  type ProjectFacts,
} from "~/domains/projects/stream-processors/project/contract.ts";
import { ProjectProcessor } from "~/domains/projects/stream-processors/project/implementation.ts";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import {
  bundleWorkerCode,
  cloneWorkerRepo,
  readLoopbackExports,
  WorkerHost,
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
import { ContextRegistry, durableObjectFacetsHook, type LiveCapTarget } from "~/itx/registry.ts";
import { platformProjectContext } from "~/itx/code-contexts.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import { ITX_AUDIT_STREAM_PATH, resolveDialableTargets } from "~/itx/protocol.ts";
import type {
  CapInvoke,
  CapMeta,
  PathCall,
  PathCallTarget,
  SerializableCapTarget,
} from "~/itx/protocol.ts";

type CaptunServerTunnel = Fetcher & Disposable;

/** Project DOs are addressed by the plain project id. */
export function getProjectDurableObjectName(projectId: string) {
  return projectId;
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
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type ProjectRuntimeEnv = {
  LOADER: WorkerLoaderBinding;
  WORKSPACE: DurableObjectNamespace;
};

export class ProjectDurableObject extends DurableObject<ProjectEnv> {
  // ---- processor: the project's durable state ----------------------------
  //
  // The root stream ("/") is the record; ProjectProcessor projects it into
  // the snapshot this DO reads back and owns every creation side effect.

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
  #projectProcessor = this.host.add(
    ProjectProcessorContract.slug,
    (deps) =>
      new ProjectProcessor({
        ...deps,
        appConfig: () => this.getAppConfig(),
        env: this.env,
        exports: this.ctx.exports,
        projectId: () => this.projectId,
        workerHost: this.workerHost,
      }),
  );

  /**
   * The project's processor, part of the DO's public surface:
   *
   *   await itx.project.processor.snapshot();   // one expression via itx
   *
   * A prototype getter (own instance fields don't cross Workers RPC). The
   * one-expression spelling works because `itx.project` is a path proxy that
   * awaits intermediate property segments (handle.ts) — workerd itself does
   * not pipeline calls through property accesses, so code holding a RAW
   * Workers stub must await the property first:
   *
   *   const processor = await stub.processor;
   *   await processor.snapshot();
   */
  get processor() {
    return this.#projectProcessor;
  }

  #projectEgressInterceptTunnel: CaptunServerTunnel | null = null;

  /** Subscription callables on the project's root stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  // ---- identity & creation ------------------------------------------------
  //
  // Projects are intentionally ownerless at their core. Organization
  // membership is an access grant in D1, not a property of this DO, because
  // agents can create unclaimed projects that a user or organization claims
  // later, similar to Stripe sandboxes.

  /** The DO name IS the project id (see getProjectDurableObjectName). */
  private get projectId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("ProjectDurableObject must be addressed by name (the project id).");
    return name;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    // The DO's name IS the project id; a mismatched input would wire the
    // subscription and creation events to another project's stream.
    if (input.projectId !== this.projectId) {
      throw new Error(
        `createProject(${input.projectId}) dialed on the DO for "${this.projectId}".`,
      );
    }

    // Both appends are idempotent, as is every downstream creation step —
    // calling createProject again is a no-op that returns the summary.
    await this.ensureProjectSubscription(input.projectId);
    const stream = await this.projectStream(input.projectId);
    await stream.append({
      type: "events.iterate.com/project/create-requested",
      idempotencyKey: `project-create-requested:${input.projectId}`,
      payload: { projectId: input.projectId, slug: input.slug },
    });

    // That's it — no waiting. The creation steps (D1 projection, repo,
    // example secret, agents root, created/create-completed events) run in
    // ProjectProcessor and leave a trail on the root stream; callers redirect
    // to the project immediately and watch `processor.snapshot()`
    // (phase: creating → ready) if they care about progress.
    return toSummary(projectFacts({ config: this.getAppConfig(), ...input }));
  }

  async getSummary(): Promise<ProjectSummary> {
    return await this.requireSummary();
  }

  async describe(): Promise<ProjectSummary & { ingressUrl: string }> {
    return {
      ...(await this.requireSummary()),
      ingressUrl: await this.ingressUrl(),
    };
  }

  async ingressUrl(): Promise<string> {
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
    return this.itxRegistry().provide(input);
  }

  async itxDefine(input: {
    name: string;
    target: SerializableCapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    return this.itxRegistry().define(input);
  }

  async itxRevoke(input: { name: string }) {
    return this.itxRegistry().revoke(input);
  }

  async itxDescribe() {
    return this.itxRegistry().describe();
  }

  async itxInvoke(input: PathCall & { name: string }) {
    return await this.itxRegistry().invoke(input.name, { args: input.args, path: input.path });
  }

  private itxRegistry(): ContextRegistry {
    if (this.#itxRegistry) return this.#itxRegistry;
    const projectId = this.projectId;
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
      // The code-defined parent context: platform defaults every project
      // falls through to, shadowable by this project's own rows (§8).
      defaults: platformProjectContext,
      dialable: resolveDialableTargets(parseConfig(this.env).itx),
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
      sql: this.ctx.storage.sql,
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
    const summary = await this.requireSummary();
    const checkout = await this.workerHost.buildFresh(summary);
    const entrypoint = this.workerHost.load({ checkout, projectId: summary.id });
    return await replayPathCall(entrypoint, { args: input.args ?? [], path: input.path });
  }

  /**
   * itx `{ type: "project-worker" }` refs dispatch here (via the
   * ProjectWorker loopback forwarder, itx/caps/project-worker.ts): a named
   * export of the project's OWN worker is the capability target — user
   * space, same shape as first-party. The whole call arrives as data because
   * loader entrypoints cannot cross an RPC boundary; the entrypoint is
   * instantiated per call with the registry-merged props (definer
   * parameterization + { cap, context, projectId } attribution).
   */
  async itxProjectWorkerCall(input: {
    call: PathCall;
    entrypoint?: string;
    invoke: CapInvoke;
    props: Record<string, unknown>;
  }): Promise<unknown> {
    const summary = await this.requireSummary();
    const checkout = await this.workerHost.buildFresh(summary);
    const worker = this.workerHost.loadWorker({ checkout, projectId: summary.id });
    const entrypoint = worker.getEntrypoint(input.entrypoint, { props: input.props }) as unknown;
    try {
      if (input.invoke === "path-call") {
        return await (entrypoint as PathCallTarget).call(input.call);
      }
      return await replayPathCall(entrypoint, input.call);
    } finally {
      (entrypoint as Partial<Disposable>)?.[Symbol.dispose]?.();
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

    const secrets = getSecretsCapability({
      exports: readLoopbackExports(this.ctx.exports),
      props: { projectId: this.projectId },
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

  // ---- plumbing ------------------------------------------------------------

  private async requireSummary(): Promise<ProjectSummary> {
    const summary = await this.currentSummary();
    if (!summary) throw new Error("Project has not been created yet.");
    return summary;
  }

  private async currentSummary(): Promise<ProjectSummary | null> {
    const snapshot = await this.#projectProcessor.snapshot();
    if (snapshot.state.project) return toSummary(snapshot.state.project);

    // Cold path: the snapshot can lag the create-requested append by a beat.
    // The D1 projection is the first creation step and hosts derive purely
    // from (projectId, slug, config), so reconstruct from D1.
    const projectId = this.projectId;
    const row = await this.env.DB.prepare(`SELECT slug FROM projects WHERE id = ?`)
      .bind(projectId)
      .first<{ slug: string }>();
    if (!row) return null;
    return toSummary(projectFacts({ config: this.getAppConfig(), projectId, slug: row.slug }));
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
      type: "events.iterate.com/stream/subscription-configured",
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

function isHttpRequestUrl(urlString: string) {
  const url = new URL(urlString);
  return url.protocol === "http:" || url.protocol === "https:";
}

function projectRuntimeEnv(env: ProjectEnv): ProjectRuntimeEnv {
  return env as unknown as ProjectRuntimeEnv;
}
