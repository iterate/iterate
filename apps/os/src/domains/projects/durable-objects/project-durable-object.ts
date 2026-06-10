import { env } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { z } from "zod";
import { acceptCaptunTunnel, type Fetcher } from "captun";
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath, type Event } from "@iterate-com/shared/streams/types";
import { typeid } from "@iterate-com/shared/typeid";
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
} from "~/domains/streams/new-stream-runtime.ts";
import { parseConfig } from "~/config.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";
import type { ItxProps } from "~/itx/protocol.ts";
import type { ProjectEgressProps } from "~/itx/entrypoint.ts";
import {
  AGENTS_STREAM_PATH,
  type AgentDurableObject,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { deleteIngressRoutesByProject, upsertIngressRoute } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  ingressHostnameFromRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import {
  PROJECT_CNAME_RECORD_CREATED_EVENT_TYPE,
  PROJECT_CNAME_RECORD_CREATION_FAILED_EVENT_TYPE,
  PROJECT_CONFIG_WORKER_BUILT_EVENT_TYPE,
  PROJECT_LIFECYCLE_STREAM_PATH,
  ProjectLifecycleProcessor,
  ProjectLifecycleProcessorContract,
} from "~/domains/projects/stream-processors/project-lifecycle.ts";
import { createProjectWildcardCNAMERecord as createCloudflareProjectWildcardCNAMERecord } from "~/domains/projects/cloudflare-dns.ts";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import {
  type RepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";
import { ensureIterateConfigInfoForProject } from "~/domains/repos/entrypoints/repo-capability.ts";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import type { StreamsCapabilityProps } from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
  EXAMPLE_EGRESS_SECRET_METADATA,
} from "~/domains/secrets/example-secret.ts";
import { ContextRegistry, durableObjectFacetsHook, type LiveCapTarget } from "~/itx/registry.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import { ITX_AUDIT_STREAM_PATH } from "~/itx/protocol.ts";
import type { CapInvoke, CapMeta, CapSource, PathCall } from "~/itx/protocol.ts";

type CaptunServerTunnel = Fetcher & Disposable;
export type ProjectStructuredName = {
  projectId: string;
};

const ProjectStructuredName = z.object({
  projectId: z.string(),
});

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

export type ProjectCapability = Pick<
  ProjectDurableObject,
  | "afterAppend"
  | "callConfigWorkerFunction"
  | "createProject"
  | "describe"
  | "egressFetch"
  | "fetch"
  | "getConfigWorker"
  | "getProjectLifecycleRunnerState"
  | "getSummary"
  | "ingressFetch"
  | "ingressUrl"
  | "itxDefine"
  | "itxDescribe"
  | "itxInvoke"
  | "itxProvide"
  | "itxRevoke"
>;

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

type ProjectStateRow = {
  id: string;
  slug: string;
  default_host: string;
  hosts_json: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type ProjectIngressRouteRow = {
  id: string;
  host: string;
  project_id: string | null;
  priority: number;
  notes: string | null;
  callable_json: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ProjectDynamicWorkerEntrypoint = {
  [key: string]: any;
  [Symbol.dispose]?(): void;
  fetch(request: Request): Response | Promise<Response>;
  afterAppend?(input: { event: Event }): unknown | Promise<unknown>;
};

type ProjectDynamicWorkerModule =
  | string
  | {
      cjs?: string;
      data?: ArrayBuffer;
      js?: string;
      json?: object;
      text?: string;
    };

type ProjectDynamicWorkerCode = {
  compatibilityDate: string;
  env?: Record<string, unknown>;
  compatibilityFlags: string[];
  globalOutbound: Fetcher | null;
  mainModule: string;
  modules: Record<string, ProjectDynamicWorkerModule>;
};

type ProjectDynamicWorkerLoader = {
  get(
    name: string,
    getCode: () => ProjectDynamicWorkerCode,
  ): {
    getEntrypoint(): unknown;
  };
  load(code: ProjectDynamicWorkerCode): {
    getEntrypoint(): unknown;
  };
};

type ProjectRuntimeEnv = {
  LOADER: ProjectDynamicWorkerLoader;
  WORKSPACE: DurableObjectNamespace;
};

type ProjectConfigCheckout = {
  commitOid: string;
  workerCode: ProjectDynamicWorkerCode;
};

type ProjectConfigGit = {
  clone(input: Record<string, unknown>): Promise<unknown>;
  log(input: { depth: number; dir: string; ref: string }): Promise<Array<{ oid: string }>>;
  pull(input: Record<string, unknown>): Promise<unknown>;
  status(input: { dir: string }): Promise<unknown>;
};

type ProjectConfigWorkspace = {
  git: ProjectConfigGit;
  workspace: ProjectConfigWorkspaceStub;
};

const PROJECT_CONFIG_WORKSPACE_ID = "project-ingress";
const PROJECT_CONFIG_DIR = "/iterate-config";
const PROJECT_CONFIG_WORKER_PATH = `${PROJECT_CONFIG_DIR}/worker.js`;
const PROJECT_CONFIG_CHECKOUT_STORAGE_KEY = "project.configWorker.checkout";
const PROJECT_CONFIG_READY_STORAGE_KEY = "project.configWorker.ready";
const PROJECT_CONFIG_REFRESHED_AT_STORAGE_KEY = "project.configWorker.refreshedAt";
const PROJECT_CONFIG_REFRESH_INTERVAL_MS = 10_000;
const PROJECT_DYNAMIC_WORKER_MAIN_MODULE = "worker.js";
const PROJECT_DYNAMIC_WORKER_COMPATIBILITY_DATE = "2026-04-27";
const PROJECT_DYNAMIC_WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];
const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

type ProjectConfigWorkspaceName = {
  projectId: string;
  workspaceId: string;
};

type ProjectConfigWorkspaceStub = {
  cloudflareShellGit(): Promise<unknown>;
  cloudflareShellState(): Promise<Record<string, unknown>>;
  hasFile(path: string): Promise<boolean>;
  initialize(input: { name: string }): Promise<unknown>;
  removePath(input: { force: boolean; path: string; recursive: boolean }): Promise<void>;
};

const ProjectLifecycleBase = createIterateDurableObjectBase<
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

export class ProjectDurableObject extends ProjectLifecycleBase<ProjectEnv> {
  host = createStreamProcessorHost(this.ctx);
  projectLifecycle = this.host.add(
    ProjectLifecycleProcessorContract.slug,
    (deps) => new ProjectLifecycleProcessor(deps),
  );

  #dynamicWorkerEntrypoint: {
    commitOid: string;
    entrypoint: ProjectDynamicWorkerEntrypoint;
  } | null = null;
  #projectEgressInterceptTunnel: CaptunServerTunnel | null = null;
  #projectConfigWorkerBuildPromise: Promise<ProjectDynamicWorkerEntrypoint> | null = null;

  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    const sql = this.getDurableObjectSql();
    // Projects are intentionally ownerless at their core. Organization
    // membership is an access grant in D1, not a property of the Project Durable Object,
    // because we want agents to be able to create unclaimed projects and let a
    // user or organization claim them later, similar to Stripe sandboxes.
    sql.exec(`CREATE TABLE IF NOT EXISTS project_state (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      default_host TEXT NOT NULL,
      hosts_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS project_ingress_routes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL UNIQUE,
      project_id TEXT,
      priority INTEGER NOT NULL,
      notes TEXT,
      callable_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_ingress_routes_host
      ON project_ingress_routes (host)`);

    this.registerOnFirstInitialize(async (params) => {
      await this.ensureProjectLifecycleSubscription(params.projectId);
      await this.ensureAgentsRoot(params.projectId);
    });
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    await this.initialize({
      name: getProjectDurableObjectName(input.projectId),
    });
    await this.ensureStarted();

    const now = Date.now();
    const config = this.getAppConfig();
    const hosts = projectHosts({
      bases: config.projectHostnameBases,
      projectId: input.projectId,
      slug: input.slug,
    });
    const defaultHost = hosts.defaultHost;

    this.getDurableObjectSql().exec(
      `INSERT INTO project_state
        (id, slug, default_host, hosts_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        default_host = excluded.default_host,
        hosts_json = excluded.hosts_json,
        updated_at_ms = excluded.updated_at_ms`,
      input.projectId,
      input.slug,
      defaultHost,
      JSON.stringify(hosts.projectHosts),
      now,
      now,
    );

    await upsertProjectProjection({
      db: this.env.DB,
      input,
    });
    await this.ensureExampleEgressSecret(input.projectId);
    await this.writeIngressRoutes({ hosts, projectId: input.projectId });
    const summary = this.requireSummary();
    await this.writeProjectCreatedLifecycleEvent(summary);
    void this.createProjectWildcardCNAMERecord(summary).catch((error) => {
      console.error(
        `[ProjectDNS] Wildcard DNS record fire-and-forget task failed for ${summary.id}:`,
        error,
      );
    });

    // Defer heavy setup (config worker build, agents root) so the create call returns fast.
    this.ctx.waitUntil(this.finishProjectSetup(summary));

    return summary;
  }

  private async finishProjectSetup(summary: ProjectSummary) {
    try {
      const projectConfigCheckout = await this.buildFreshProjectDynamicWorker(summary);
      await this.writeProjectConfigWorkerBuiltLifecycleEvent({
        checkout: projectConfigCheckout,
        summary,
      });
      await this.writeAgentsRootRule(summary);
    } catch (error) {
      console.error(`[ProjectDO] finishProjectSetup failed for ${summary.id}:`, error);
    }
  }

  private async ensureExampleEgressSecret(projectId: string) {
    const secrets = getSecretsCapability({
      exports: readLoopbackExports(this.ctx),
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

  async getSummary(): Promise<ProjectSummary> {
    await this.ensureStarted();
    return this.requireSummary();
  }

  async describe(): Promise<ProjectSummary & { ingressUrl: string }> {
    await this.ensureStarted();
    return {
      ...this.requireSummary(),
      ingressUrl: await this.ingressUrl(),
    };
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
    source: CapSource;
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

  async ingressUrl(): Promise<string> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const config = this.getAppConfig();
    const row = await this.env.DB.prepare(`SELECT custom_hostname FROM projects WHERE id = ?`)
      .bind(summary.id)
      .first<{ custom_hostname: string | null }>();
    const host = row?.custom_hostname?.trim().toLowerCase() || summary.defaultHost;
    const protocol = config.baseUrl ? new URL(config.baseUrl).protocol : "https:";
    return new URL(`${protocol}//${host}`).origin;
  }

  /** Subscription callables on the project lifecycle stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  async getProjectLifecycleRunnerState() {
    await this.ensureStarted();
    const snapshot = await this.projectLifecycle.snapshot();
    // Legacy runner runtimeState shape, kept for existing callers/tests. The
    // class model has a single checkpoint, so both offsets are the same.
    return {
      processorSlug: this.projectLifecycle.contract.slug,
      snapshot,
      state: snapshot.state,
      reducedThroughOffset: snapshot.offset,
      afterAppendCompletedThroughOffset: snapshot.offset,
    };
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    const summary = this.currentSummary();
    const configWorkerIsReady = await this.ctx.storage.get<boolean>(
      PROJECT_CONFIG_READY_STORAGE_KEY,
    );
    if (summary !== null && configWorkerIsReady === true) {
      try {
        const entrypoint =
          this.#dynamicWorkerEntrypoint?.entrypoint ??
          (await this.getCachedProjectDynamicWorkerEntrypoint(summary));
        await entrypoint.afterAppend?.(input);
      } catch (error) {
        console.error("Project config worker afterAppend failed.", error);
      }
    }
    return await this.getProjectLifecycleRunnerState();
  }

  async ingressFetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const url = new URL(request.url);

    if (url.pathname === "/__iterate/intercept-project-egress") {
      return this.acceptProjectEgressInterceptTunnel(request);
    }

    const host = normalizeIngressHost(ingressHostnameFromRequest(request));
    const route = this.lookupLocalRoute(host);

    if (route) {
      return await dispatchFetchCallable({
        callable: route.callable,
        context: {
          env: this.env as unknown as Record<string, unknown>,
          exports: readLoopbackExports(this.ctx),
        },
        request,
      });
    }

    let entrypoint: ProjectDynamicWorkerEntrypoint;
    try {
      entrypoint = await this.getIngressProjectDynamicWorkerEntrypoint(summary);
    } catch (error) {
      if (error instanceof ProjectConfigWorkerUnavailableError) {
        return projectWorkerBuildingResponse();
      }

      console.error("Project config worker load failed; serving fallback landing response.", error);
      return projectLandingResponse({ request, summary });
    }

    try {
      return await entrypoint.fetch(
        withProjectAppSlug({
          appSlug: await this.projectAppSlugFromHost({ host, summary }),
          request,
        }),
      );
    } catch (error) {
      console.error(
        "Project config worker fetch failed; serving fallback landing response.",
        error,
      );
      return projectLandingResponse({ request, summary });
    }
  }

  async egressFetch(request: Request): Promise<Response> {
    if (!isHttpRequestUrl(request.url)) {
      return await fetch(request);
    }

    await this.ensureStarted();
    const summary = this.requireSummary();
    const secrets = getSecretsCapability({
      exports: readLoopbackExports(this.ctx),
      props: { projectId: summary.id },
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

  async callConfigWorkerFunction(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const checkout = await this.buildFreshProjectDynamicWorker(summary);
    // The config worker's env.ITERATE is a project-scoped ItxEntrypoint wired
    // at load time, so tool calls need no per-call context construction. If a
    // tool wants shortcuts like itx.slack, those are registry capabilities
    // (itx.caps.provide/define) — durable wiring, not per-load props. This is
    // what deleted the old getIterateContextProps() two-step load.
    //
    // Every public method/getter on the config worker entrypoint is proxied
    // automatically via the shared path replay — exactly like worker/facet
    // caps — so adding an exported method makes itx.worker.foo() work with no
    // wiring here.
    const entrypoint = this.loadProjectDynamicWorkerEntrypoint({
      checkout,
      projectId: summary.id,
    });
    return await replayPathCall(entrypoint, { args: input.args ?? [], path: input.path });
  }

  async getConfigWorker(): Promise<ProjectDynamicWorkerEntrypoint> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    return await this.getFreshProjectDynamicWorkerEntrypoint(summary);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.ingressFetch(request);
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

  private async getIngressProjectDynamicWorkerEntrypoint(
    summary: ProjectSummary,
  ): Promise<ProjectDynamicWorkerEntrypoint> {
    if (await this.projectConfigCheckoutIsFresh()) {
      try {
        return await this.getCachedProjectDynamicWorkerEntrypoint(summary);
      } catch (error) {
        await this.clearProjectConfigWorkerReady();
        console.error("Cached project config worker is invalid.", error);
      }
    }

    const cachedWorker = await this.getAvailableCachedProjectDynamicWorkerEntrypoint(summary);
    if (this.#projectConfigWorkerBuildPromise !== null) {
      if (cachedWorker !== null) return cachedWorker;
      throw new ProjectConfigWorkerUnavailableError("Project config worker is still building.");
    }

    this.startProjectConfigWorkerBuild(summary);
    if (cachedWorker !== null) return cachedWorker;
    throw new ProjectConfigWorkerUnavailableError("Project config worker is building.");
  }

  private async getAvailableCachedProjectDynamicWorkerEntrypoint(
    summary: ProjectSummary,
  ): Promise<ProjectDynamicWorkerEntrypoint | null> {
    try {
      return await this.getCachedProjectDynamicWorkerEntrypoint(summary);
    } catch (error) {
      await this.clearProjectConfigWorkerReady();
      console.error("Cached project config worker is unavailable.", error);
      return null;
    }
  }

  private startProjectConfigWorkerBuild(summary: ProjectSummary) {
    const buildPromise = this.getFreshProjectDynamicWorkerEntrypoint(summary);
    this.#projectConfigWorkerBuildPromise = buildPromise;
    this.ctx.waitUntil(
      buildPromise
        .catch((error) => {
          console.error("Project config worker build failed.", error);
        })
        .finally(() => {
          if (this.#projectConfigWorkerBuildPromise === buildPromise) {
            this.#projectConfigWorkerBuildPromise = null;
          }
        }),
    );
  }

  private async getFreshProjectDynamicWorkerEntrypoint(
    summary: ProjectSummary,
  ): Promise<ProjectDynamicWorkerEntrypoint> {
    const checkout = await this.buildFreshProjectDynamicWorker(summary);
    return this.loadProjectDynamicWorkerEntrypoint({ checkout, projectId: summary.id });
  }

  private async buildFreshProjectDynamicWorker(summary: ProjectSummary) {
    const checkout = await this.ensureProjectConfigCheckout(summary);
    this.loadProjectDynamicWorkerEntrypoint({ checkout, projectId: summary.id });
    await this.ctx.storage.put(PROJECT_CONFIG_CHECKOUT_STORAGE_KEY, checkout);
    await this.ctx.storage.put(PROJECT_CONFIG_READY_STORAGE_KEY, true);
    await this.ctx.storage.put(PROJECT_CONFIG_REFRESHED_AT_STORAGE_KEY, Date.now());
    return checkout;
  }

  private async getCachedProjectDynamicWorkerEntrypoint(
    summary: ProjectSummary,
  ): Promise<ProjectDynamicWorkerEntrypoint> {
    const checkout = await this.ctx.storage.get<ProjectConfigCheckout>(
      PROJECT_CONFIG_CHECKOUT_STORAGE_KEY,
    );
    if (!isProjectConfigCheckout(checkout)) {
      throw new Error("Project config worker is marked ready but has no validated checkout.");
    }

    return this.loadProjectDynamicWorkerEntrypoint({ checkout, projectId: summary.id });
  }

  private loadProjectDynamicWorkerEntrypoint(input: {
    checkout: ProjectConfigCheckout;
    projectId: string;
  }): ProjectDynamicWorkerEntrypoint {
    const { checkout } = input;
    if (this.#dynamicWorkerEntrypoint?.commitOid === checkout.commitOid) {
      return this.#dynamicWorkerEntrypoint.entrypoint;
    }

    const loader = projectRuntimeEnv(this.env).LOADER;
    const exports = readLoopbackExports(this.ctx);
    const workerCode = projectDynamicWorkerCodeWithBindings({
      // The config worker is cap #0's code: it gets a project-scoped itx
      // (env.ITERATE.context) and the project egress pipe as its global
      // fetch. It can never reach wider than its own project, and its bare
      // fetch() gets secret substitution like every other loaded isolate.
      globalOutbound: exports.ProjectEgress({
        props: { cap: "configWorker", context: input.projectId, project: input.projectId },
      }),
      iterate: exports.ItxEntrypoint({
        props: { cap: "configWorker", context: input.projectId },
      }),
      streams: exports.StreamsCapability({
        props: { projectId: input.projectId },
      }),
      workerCode: checkout.workerCode,
    });
    const worker = loader.get(
      projectDynamicWorkerId({
        commitOid: checkout.commitOid,
        projectId: input.projectId,
      }),
      () => workerCode,
    );
    const entrypoint = worker.getEntrypoint();

    if (!isProjectDynamicWorkerEntrypoint(entrypoint)) {
      throw new Error("Project dynamic worker entrypoint is missing fetch.");
    }

    this.#dynamicWorkerEntrypoint = {
      commitOid: checkout.commitOid,
      entrypoint,
    };
    return entrypoint;
  }

  private async clearProjectConfigWorkerReady() {
    this.#dynamicWorkerEntrypoint = null;
    await this.ctx.storage.delete(PROJECT_CONFIG_READY_STORAGE_KEY);
    await this.ctx.storage.delete(PROJECT_CONFIG_CHECKOUT_STORAGE_KEY);
    await this.ctx.storage.delete(PROJECT_CONFIG_REFRESHED_AT_STORAGE_KEY);
  }

  private async projectConfigCheckoutIsFresh() {
    const refreshedAt = await this.ctx.storage.get<number>(PROJECT_CONFIG_REFRESHED_AT_STORAGE_KEY);
    return (
      typeof refreshedAt === "number" &&
      Number.isFinite(refreshedAt) &&
      Date.now() - refreshedAt < PROJECT_CONFIG_REFRESH_INTERVAL_MS
    );
  }

  private async ensureProjectConfigCheckout(
    summary: ProjectSummary,
  ): Promise<ProjectConfigCheckout> {
    const repo = await this.getOrCreateIterateConfigRepo(summary);
    const { git, workspace } = await this.getProjectConfigWorkspace(summary.id);

    await workspace.removePath({
      force: true,
      path: PROJECT_CONFIG_DIR,
      recursive: true,
    });
    await this.cloneProjectConfigRepo({ git, repo, workspace });
    return await this.readProjectConfigCheckout({ git, workspace });
  }

  protected async cloneProjectConfigRepo(input: ProjectConfigWorkspace & { repo: RepoInfo }) {
    await input.git.clone({
      url: input.repo.remote,
      dir: PROJECT_CONFIG_DIR,
      branch: input.repo.defaultBranch,
      depth: 1,
      ...artifactGitAuth(input.repo),
    });
  }

  private async readProjectConfigCheckout(input: ProjectConfigWorkspace) {
    const [commit] = await input.git.log({
      dir: PROJECT_CONFIG_DIR,
      depth: 1,
      ref: "HEAD",
    });
    if (!commit) {
      throw new Error("Project iterate-config checkout does not have a HEAD commit.");
    }

    const state = await input.workspace.cloudflareShellState();
    const files = await readProjectConfigFiles(state);
    const workerSource = files[PROJECT_DYNAMIC_WORKER_MAIN_MODULE];
    if (typeof workerSource !== "string" || workerSource.trim() === "") {
      throw new Error(`${ITERATE_CONFIG_REPO_SLUG} repo is missing worker.js.`);
    }
    const workerCode =
      typeof files["package.json"] === "string" && files["package.json"].trim() !== ""
        ? await this.bundleProjectDynamicWorkerCode(files)
        : projectDynamicWorkerCode(workerSource);

    return {
      commitOid: commit.oid,
      workerCode,
    };
  }

  protected async bundleProjectDynamicWorkerCode(
    files: Record<string, string>,
  ): Promise<ProjectDynamicWorkerCode> {
    return await bundledProjectDynamicWorkerCode(files);
  }

  private async getProjectConfigWorkspace(projectId: string): Promise<ProjectConfigWorkspace> {
    const name = projectConfigWorkspaceName(projectId);
    const durableObjectName = deriveDurableObjectNameFromStructuredName({ structuredName: name });
    const workspace = projectRuntimeEnv(this.env).WORKSPACE.getByName(
      durableObjectName,
    ) as unknown as ProjectConfigWorkspaceStub;
    await workspace.initialize({ name: durableObjectName });

    return {
      git: (await workspace.cloudflareShellGit()) as unknown as ProjectConfigGit,
      workspace,
    };
  }

  private lookupLocalRoute(host: string): ExactHostIngressRule | null {
    const row = this.getDurableObjectSql()
      .exec<ProjectIngressRouteRow>(
        `SELECT id, host, project_id, priority, notes, callable_json, created_at_ms, updated_at_ms
         FROM project_ingress_routes
         WHERE host = ?
         ORDER BY priority DESC, created_at_ms ASC
         LIMIT 1`,
        host,
      )
      .toArray()[0];

    if (!row) return null;

    return {
      id: row.id,
      host: row.host,
      projectId: row.project_id,
      priority: row.priority,
      notes: row.notes,
      callable: parseIngressCallable(row.callable_json),
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    };
  }

  private async writeIngressRoutes(input: {
    hosts: ReturnType<typeof projectHosts>;
    projectId: string;
  }) {
    const db = createD1Client(this.env.DB);
    await deleteIngressRoutesByProject(db, { projectId: input.projectId });
    this.getDurableObjectSql().exec(`DELETE FROM project_ingress_routes`);

    for (const host of input.hosts.projectHosts) {
      const callable = {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectIngressEntrypoint",
          props: { projectId: input.projectId },
        },
      } satisfies FetchCallable;
      await this.writeGlobalRoute({
        callable,
        host,
        notes: "Project ingress host",
        projectId: input.projectId,
      });
    }
  }

  private async writeGlobalRoute(input: {
    callable: FetchCallable;
    host: string;
    notes: string;
    projectId: string;
  }) {
    await upsertIngressRoute(createD1Client(this.env.DB), {
      id: this.createTypeId("route"),
      host: normalizeIngressHost(input.host),
      projectId: input.projectId,
      priority: 100,
      notes: input.notes,
      callableJson: JSON.stringify(input.callable),
    });
  }

  private writeLocalRoute(input: {
    callable: FetchCallable;
    host: string;
    notes: string;
    projectId: string;
  }) {
    const now = Date.now();
    this.getDurableObjectSql().exec(
      `INSERT INTO project_ingress_routes
        (id, host, project_id, priority, notes, callable_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
        project_id = excluded.project_id,
        priority = excluded.priority,
        notes = excluded.notes,
        callable_json = excluded.callable_json,
        updated_at_ms = excluded.updated_at_ms`,
      this.createTypeId("route"),
      normalizeIngressHost(input.host),
      input.projectId,
      100,
      input.notes,
      JSON.stringify(input.callable),
      now,
      now,
    );
  }

  private requireSummary(): ProjectSummary {
    const summary = this.currentSummary();
    if (!summary) throw new Error("Project has not been created yet.");
    return summary;
  }

  private currentSummary(): ProjectSummary | null {
    const row = this.getDurableObjectSql()
      .exec<ProjectStateRow>(
        `SELECT id, slug, default_host, hosts_json, created_at_ms, updated_at_ms
         FROM project_state
         LIMIT 1`,
      )
      .toArray()[0];

    if (!row) return null;

    return {
      id: row.id,
      slug: row.slug,
      defaultHost: row.default_host,
      hosts: JSON.parse(row.hosts_json) as string[],
    };
  }

  private createTypeId(prefix: string) {
    return typeid({
      env: { TYPEID_PREFIX: this.getAppConfig().typeIdPrefix },
      prefix,
    });
  }

  private getAppConfig() {
    return parseConfig(this.env);
  }

  private async writeProjectCreatedLifecycleEvent(summary: ProjectSummary) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: summary.id,
      path: PROJECT_LIFECYCLE_STREAM_PATH,
    });

    await stream.append({
      type: "events.iterate.com/project/created",
      idempotencyKey: `project-created:${summary.id}`,
      payload: {
        defaultHost: summary.defaultHost,
        hosts: summary.hosts,
        projectId: summary.id,
        slug: summary.slug,
      },
    });
  }

  private async writeProjectConfigWorkerBuiltLifecycleEvent(input: {
    checkout: ProjectConfigCheckout;
    summary: ProjectSummary;
  }) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: input.summary.id,
      path: PROJECT_LIFECYCLE_STREAM_PATH,
    });

    await stream.append({
      type: PROJECT_CONFIG_WORKER_BUILT_EVENT_TYPE,
      idempotencyKey: `project-config-worker-built:${input.summary.id}:${input.checkout.commitOid}`,
      payload: {
        commitOid: input.checkout.commitOid,
        mainModule: input.checkout.workerCode.mainModule,
        projectId: input.summary.id,
        repoSlug: ITERATE_CONFIG_REPO_SLUG,
      },
    });
  }

  private async createProjectWildcardCNAMERecord(summary: ProjectSummary) {
    const config = this.getAppConfig();
    const base = config.projectHostnameBases[0];
    try {
      const result = await createCloudflareProjectWildcardCNAMERecord({
        apiToken: config.cloudflare.apiToken?.exposeSecret(),
        projectHostnameBase: base,
        projectId: summary.id,
        projectSlug: summary.slug,
      });
      if (result === null) return;
      await this.writeProjectCNAMERecordCreatedLifecycleEvent({
        result,
        summary,
      });
    } catch (error) {
      console.error(`[ProjectDNS] Wildcard DNS record creation failed for ${summary.id}:`, error);
      await this.writeProjectCNAMERecordCreationFailedLifecycleEvent({
        base,
        error,
        summary,
      });
    }
  }

  private async writeProjectCNAMERecordCreatedLifecycleEvent(input: {
    result: Awaited<ReturnType<typeof createCloudflareProjectWildcardCNAMERecord>>;
    summary: ProjectSummary;
  }) {
    if (input.result === null) return;
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: input.summary.id,
      path: PROJECT_LIFECYCLE_STREAM_PATH,
    });

    await stream.append({
      type: PROJECT_CNAME_RECORD_CREATED_EVENT_TYPE,
      idempotencyKey: `project-cname-record-created:${input.summary.id}:${input.result.name}`,
      payload: {
        base: input.result.base,
        cloudflareRecord: input.result.record,
        name: input.result.name,
        projectId: input.summary.id,
        projectSlug: input.summary.slug,
        target: input.result.target,
        zoneId: input.result.zoneId,
        zoneName: input.result.zoneName,
      },
    });
  }

  private async writeProjectCNAMERecordCreationFailedLifecycleEvent(input: {
    base: string | undefined;
    error: unknown;
    summary: ProjectSummary;
  }) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: input.summary.id,
      path: PROJECT_LIFECYCLE_STREAM_PATH,
    });
    const base = input.base?.trim();

    await stream.append({
      type: PROJECT_CNAME_RECORD_CREATION_FAILED_EVENT_TYPE,
      idempotencyKey: `project-cname-record-creation-failed:${input.summary.id}:${Date.now()}`,
      payload: {
        ...(base ? { base, name: `*.${input.summary.slug}.${base}` } : {}),
        message: errorMessage(input.error),
        projectId: input.summary.id,
        projectSlug: input.summary.slug,
      },
    });
  }

  private async getOrCreateIterateConfigRepo(summary: ProjectSummary) {
    return await ensureIterateConfigInfoForProject({
      env: this.env,
      projectId: summary.id,
      projectSlug: summary.slug,
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

  private async writeAgentsRootRule(summary: ProjectSummary) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: summary.id,
      path: AGENTS_STREAM_PATH,
    });

    await stream.append({
      type: jsonataReactorEventTypes.ruleConfigured,
      idempotencyKey: `agents-child-stream-setup:${summary.id}`,
      payload: {
        slug: "agents-child-stream-setup",
        matcher: "type = 'events.iterate.com/stream/child-stream-created'",
        reactions: [],
      },
    });
  }

  private async ensureProjectLifecycleSubscription(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: PROJECT_LIFECYCLE_STREAM_PATH,
    });

    // ":callable" suffix: the subscriber switched from the legacy built-in
    // runner to a Callable subscription. Changing the idempotency key lets the
    // new subscription-configured event land on existing streams that already
    // recorded the old one.
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `project-lifecycle-subscription:${projectId}:workers-rpc:callable`,
      payload: {
        subscriptionKey: projectLifecycleSubscriptionKey(projectId),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "PROJECT",
          durableObjectName: getProjectDurableObjectName(projectId),
          processorName: ProjectLifecycleProcessorContract.slug,
        }),
      },
    });
  }

  private async projectAppSlugFromHost(input: { host: string; summary: ProjectSummary }) {
    const platformHosts = parseProjectPlatformHosts({
      bases: this.getAppConfig().projectHostnameBases,
      host: input.host,
    });
    for (const platformHost of platformHosts) {
      if (
        platformHost.projectIdentifier === input.summary.slug ||
        platformHost.projectIdentifier === input.summary.id
      ) {
        return platformHost.appSlug;
      }
    }

    const row = await this.env.DB.prepare(`SELECT custom_hostname FROM projects WHERE id = ?`)
      .bind(input.summary.id)
      .first<{ custom_hostname: string | null }>();
    const customHostname = row?.custom_hostname?.trim().toLowerCase();
    if (!customHostname) return null;

    const host = normalizeIngressHost(input.host);
    if (host === customHostname) return null;
    if (!host.endsWith(`.${customHostname}`)) return null;

    const prefix = host.slice(0, host.length - customHostname.length - 1);
    return prefix !== "" && !prefix.includes(".") ? prefix : null;
  }
}

function projectLifecycleSubscriptionKey(projectId: string) {
  return `project-lifecycle:${projectId}`;
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

function projectHosts(input: { bases: readonly string[]; projectId: string; slug: string }) {
  const projectHosts = input.bases.flatMap((base) => [
    normalizeIngressHost(`${input.slug}.${base}`),
    normalizeIngressHost(`${input.projectId}.${base}`),
  ]);
  return {
    defaultHost: normalizeIngressHost(`${input.slug}.${input.bases[0] ?? "iterate.localhost"}`),
    mcpHosts: [],
    projectHosts,
  };
}

function withProjectAppSlug(input: { appSlug: string | null; request: Request }) {
  if (input.appSlug === null) return input.request;

  const headers = new Headers(input.request.headers);
  headers.set("x-iterate-app-slug", input.appSlug);
  return new Request(input.request, { headers });
}

function projectDynamicWorkerId(input: { commitOid: string; projectId: string }) {
  return `project-ingress:v4:${input.projectId}:${input.commitOid}`;
}

function projectDynamicWorkerCode(input: string) {
  return {
    compatibilityDate: PROJECT_DYNAMIC_WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: PROJECT_DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
    globalOutbound: null,
    mainModule: PROJECT_DYNAMIC_WORKER_MAIN_MODULE,
    modules: {
      [PROJECT_DYNAMIC_WORKER_MAIN_MODULE]: {
        js: input,
      },
    },
  };
}

function projectDynamicWorkerCodeWithBindings(input: {
  globalOutbound: Fetcher;
  iterate: Fetcher;
  streams: Fetcher;
  workerCode: ProjectDynamicWorkerCode;
}): ProjectDynamicWorkerCode {
  return {
    ...input.workerCode,
    env: {
      ...(input.workerCode.env ?? {}),
      ITERATE: input.iterate,
      STREAMS: input.streams,
    },
    globalOutbound: input.globalOutbound,
    modules: {
      ...input.workerCode.modules,
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function bundledProjectDynamicWorkerCode(
  files: Record<string, string>,
): Promise<ProjectDynamicWorkerCode> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    entryPoint: PROJECT_DYNAMIC_WORKER_MAIN_MODULE,
    files,
  });

  for (const warning of result.warnings ?? []) {
    console.warn(`Project config worker bundler warning: ${warning}`);
  }

  return {
    compatibilityDate:
      result.wranglerConfig?.compatibilityDate ?? PROJECT_DYNAMIC_WORKER_COMPATIBILITY_DATE,
    compatibilityFlags:
      result.wranglerConfig?.compatibilityFlags ?? PROJECT_DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
    globalOutbound: null,
    mainModule: result.mainModule,
    modules: result.modules,
  };
}

async function readProjectConfigFiles(
  state: Record<string, unknown>,
): Promise<Record<string, string>> {
  const readFile = state.readFile;
  if (typeof readFile !== "function") {
    throw new Error("Project Workspace state does not implement readFile.");
  }
  const readTextFile = readFile as (...args: unknown[]) => unknown;

  const find = state.find;
  if (typeof find !== "function") {
    const workerSource = await readWorkspaceTextFile(readTextFile, PROJECT_CONFIG_WORKER_PATH);
    const packageJson = await readOptionalWorkspaceTextFile(
      readTextFile,
      `${PROJECT_CONFIG_DIR}/package.json`,
    );
    return packageJson === null
      ? { [PROJECT_DYNAMIC_WORKER_MAIN_MODULE]: workerSource }
      : {
          [PROJECT_DYNAMIC_WORKER_MAIN_MODULE]: workerSource,
          "package.json": packageJson,
        };
  }

  const entries = (await find(PROJECT_CONFIG_DIR, {
    type: "file",
  })) as Array<{ path?: unknown }>;
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (typeof entry.path !== "string") continue;
    const relativePath = projectConfigRelativePath(entry.path);
    if (relativePath === null) continue;

    files[relativePath] = await readWorkspaceTextFile(readTextFile, entry.path);
  }

  return files;
}

function projectConfigRelativePath(path: string) {
  if (!path.startsWith(`${PROJECT_CONFIG_DIR}/`)) return null;

  const relativePath = path.slice(PROJECT_CONFIG_DIR.length + 1);
  if (
    relativePath === "" ||
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/")
  ) {
    return null;
  }

  return relativePath;
}

async function readWorkspaceTextFile(
  readFile: (...args: unknown[]) => unknown,
  path: string,
): Promise<string> {
  const content = await readFile(path);
  if (typeof content !== "string") {
    throw new Error(`Project Workspace file ${path} did not contain text.`);
  }

  return content;
}

async function readOptionalWorkspaceTextFile(
  readFile: (...args: unknown[]) => unknown,
  path: string,
) {
  try {
    return await readWorkspaceTextFile(readFile, path);
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
}

function projectLandingResponse(input: { request: Request; summary: ProjectSummary }) {
  const url = new URL(input.request.url);
  const hostname = input.request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
  return new Response(
    JSON.stringify({
      defaultHost: input.summary.defaultHost,
      hostname,
      projectId: input.summary.id,
      slug: input.summary.slug,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-project-ingress-runtime": "static-fallback",
      },
    },
  );
}

function isHttpRequestUrl(urlString: string) {
  const url = new URL(urlString);
  return url.protocol === "http:" || url.protocol === "https:";
}

function projectWorkerBuildingResponse() {
  return new Response("This worker is currently being built.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "5",
      "x-project-ingress-runtime": "dynamic-worker-building",
    },
  });
}

class ProjectConfigWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigWorkerUnavailableError";
  }
}

function projectConfigWorkspaceName(projectId: string): ProjectConfigWorkspaceName {
  return {
    projectId,
    workspaceId: PROJECT_CONFIG_WORKSPACE_ID,
  };
}

function artifactGitAuth(repo: RepoInfo) {
  return {
    username: "x",
    password: stripArtifactTokenQuery(repo.token),
  };
}

function projectRuntimeEnv(env: ProjectEnv): ProjectRuntimeEnv {
  return env as unknown as ProjectRuntimeEnv;
}

function readLoopbackExports(ctx: DurableObjectState) {
  return ctx.exports as unknown as Cloudflare.Exports & {
    ItxEntrypoint(input: { props: ItxProps }): Fetcher;
    ProjectEgress(input: { props: ProjectEgressProps }): Fetcher;
    StreamsCapability(input: { props: StreamsCapabilityProps }): Fetcher;
  };
}

function isProjectDynamicWorkerEntrypoint(value: unknown): value is ProjectDynamicWorkerEntrypoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

function isProjectConfigCheckout(value: unknown): value is ProjectConfigCheckout {
  return (
    typeof value === "object" &&
    value !== null &&
    "commitOid" in value &&
    typeof value.commitOid === "string" &&
    value.commitOid.length > 0 &&
    "workerCode" in value &&
    isProjectDynamicWorkerCode(value.workerCode)
  );
}

function isProjectDynamicWorkerCode(value: unknown): value is ProjectDynamicWorkerCode {
  return (
    typeof value === "object" &&
    value !== null &&
    "compatibilityDate" in value &&
    typeof value.compatibilityDate === "string" &&
    "compatibilityFlags" in value &&
    Array.isArray(value.compatibilityFlags) &&
    value.compatibilityFlags.every((flag) => typeof flag === "string") &&
    "globalOutbound" in value &&
    value.globalOutbound === null &&
    "mainModule" in value &&
    typeof value.mainModule === "string" &&
    "modules" in value &&
    typeof value.modules === "object" &&
    value.modules !== null
  );
}

function isFileMissingError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("could not find") ||
    message.includes("no such file")
  );
}
