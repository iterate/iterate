import { createD1Client } from "sqlfu";
import { z } from "zod";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun/server";
import type { Callable, FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { jsonataReactorEventTypes } from "@iterate-com/shared/stream-processors/jsonata-reactor/contract";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  type Event,
  type EventInput,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import { typeid } from "@iterate-com/shared/typeid";
import { AppConfig } from "~/app.ts";
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
  createProjectLifecycleProcessor,
  PROJECT_LIFECYCLE_STREAM_PATH,
  ProjectLifecycleProcessorContract,
} from "~/domains/projects/stream-processors/project-lifecycle.ts";
import { createProjectWildcardCNAMERecord as createCloudflareProjectWildcardCNAMERecord } from "~/domains/projects/cloudflare-dns.ts";
import {
  ProjectEgressSecretSubstitutionError,
  substituteProjectEgressSecretHeaders,
} from "~/domains/projects/egress-secret-substitution.ts";
import {
  type RepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import type { StreamsCapabilityProps } from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
  EXAMPLE_EGRESS_SECRET_METADATA,
} from "~/domains/secrets/example-secret.ts";

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

export type ProjectAccessPrincipal = {
  orgId: string;
  userId: string;
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

type ProjectDynamicWorkerEntrypoint = {
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
export const PROJECT_EGRESS_INTERCEPT_ROUTE = "/__iterate/intercept-project-egress";

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

const ProjectBase = withStreamProcessorRunner<
  ProjectStructuredName,
  ProjectEnv,
  typeof ProjectLifecycleProcessorContract
>({
  processor() {
    return createProjectLifecycleProcessor();
  },
  streamApi(args) {
    return projectLifecycleStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: PROJECT_LIFECYCLE_STREAM_PATH,
    });
  },
})(ProjectLifecycleBase);

export class ProjectDurableObject extends ProjectBase<ProjectEnv> {
  #dynamicWorkerEntrypoint: {
    commitOid: string;
    entrypoint: ProjectDynamicWorkerEntrypoint;
  } | null = null;
  #projectEgressInterceptTunnel: CaptunServerTunnel | null = null;
  #projectConfigWorkerBuildPromise: Promise<ProjectDynamicWorkerEntrypoint> | null = null;

  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    const sql = this.getDurableObjectSql();
    // Projects are intentionally ownerless at their core. Clerk org membership
    // is an access grant in D1, not a property of the Project Durable Object,
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
      await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
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

  async checkAccess(input: { principal: ProjectAccessPrincipal }): Promise<ProjectSummary> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const row = await this.env.DB.prepare(
      `SELECT project_id FROM project_permissions
       WHERE project_id = ?
         AND principal_type = 'clerk_organization'
         AND principal_id = ?
       LIMIT 1`,
    )
      .bind(summary.id, input.principal.orgId)
      .first<{ project_id: string }>();

    if (!row) {
      throw new Error(`Project ${summary.id} is not available to this principal.`);
    }

    return summary;
  }

  async getSummary(): Promise<ProjectSummary> {
    await this.ensureStarted();
    return this.requireSummary();
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

  async getProjectLifecycleRunnerState() {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    const result = await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
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
    return result;
  }

  async ingressFetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const url = new URL(request.url);
    if (url.pathname === PROJECT_EGRESS_INTERCEPT_ROUTE) {
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
    const projectEgressInterceptActive = this.#projectEgressInterceptTunnel !== null;
    let substitutedHeaders: Awaited<ReturnType<typeof substituteProjectEgressSecretHeaders>>;
    try {
      substitutedHeaders = await substituteProjectEgressSecretHeaders({
        headers: request.headers,
        projectEgressInterceptActive,
        secrets,
      });
    } catch (error) {
      if (error instanceof ProjectEgressSecretSubstitutionError) {
        return error.toResponse();
      }
      throw error;
    }

    const outboundRequest = substitutedHeaders.substituted
      ? new Request(request, { headers: substitutedHeaders.headers })
      : request;

    if (projectEgressInterceptActive) {
      const egressInterceptTunnel = this.#projectEgressInterceptTunnel;
      if (egressInterceptTunnel) {
        return await egressInterceptTunnel.fetch(outboundRequest);
      }
    }

    return await fetch(outboundRequest);
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === PROJECT_EGRESS_INTERCEPT_ROUTE) {
      return this.acceptProjectEgressInterceptTunnel(request);
    }
    return await this.egressFetch(request);
  }

  private acceptProjectEgressInterceptTunnel(request: Request): Response {
    const expectedToken = this.getAppConfig().adminApiSecret?.exposeSecret();
    if (!expectedToken) {
      return Response.json(
        { error: "Project Egress Intercept Tunnel is disabled." },
        { status: 404 },
      );
    }

    if (readBearerToken(request.headers.get("authorization")) !== expectedToken) {
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
    const entrypoint = loader
      .get(
        projectDynamicWorkerId({
          commitOid: checkout.commitOid,
          projectId: input.projectId,
        }),
        () =>
          projectDynamicWorkerCodeWithStreams({
            streams: readLoopbackExports(this.ctx).StreamsCapability({
              props: { projectId: input.projectId },
            }),
            workerCode: checkout.workerCode,
          }),
      )
      .getEntrypoint();

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

    for (const host of input.hosts.mcpHosts) {
      const callable = {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectMcpServerEntrypoint",
          props: { projectId: input.projectId },
        },
      } satisfies FetchCallable;
      this.writeLocalRoute({
        callable,
        host,
        notes: "Project MCP server host",
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
      env: { TYPEID_PREFIX: this.getAppConfig().typeIdPrefix.exposeSecret() },
      prefix,
    });
  }

  private getAppConfig() {
    return parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: this.env as unknown as Record<string, unknown>,
    });
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
    return await getReposCapability({
      exports: readLoopbackExports(this.ctx),
      props: { projectId: summary.id },
    }).ensureIterateConfigInfo({ projectSlug: summary.slug });
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
        matcher: "type = 'events.iterate.com/core/child-stream-created'",
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

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `project-lifecycle-subscription:${projectId}`,
      payload: {
        slug: `project-lifecycle:${projectId}`,
        type: "callable",
        callable: this.createSelfCallable("afterAppend"),
      },
    });
  }

  private createSelfCallable(rpcMethod: string): Callable {
    return {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: "PROJECT",
        durableObject: {
          name: this.name,
        },
      },
      rpcMethod,
      argsMode: "object",
    };
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

type ProjectLifecycleStreamApi = ProcessorStreamApi<typeof ProjectLifecycleProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

function projectLifecycleStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): ProjectLifecycleStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event);
    },
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Project lifecycle processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return StreamPath.parse(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
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
  const mcpHosts = input.bases.flatMap((base) => [
    normalizeIngressHost(`mcp.${input.slug}.${base}`),
    normalizeIngressHost(`mcp.${input.projectId}.${base}`),
    normalizeIngressHost(`mcp__${input.slug}.${base}`),
    normalizeIngressHost(`mcp__${input.projectId}.${base}`),
  ]);
  return {
    defaultHost: normalizeIngressHost(`${input.slug}.${input.bases[0] ?? "iterate.localhost"}`),
    mcpHosts,
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

function projectDynamicWorkerCodeWithStreams(input: {
  streams: Fetcher;
  workerCode: ProjectDynamicWorkerCode;
}): ProjectDynamicWorkerCode {
  return {
    ...input.workerCode,
    env: {
      ...(input.workerCode.env ?? {}),
      STREAMS: input.streams,
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

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
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
