import { createD1Client } from "sqlfu";
import { z } from "zod";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import type { Callable, FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
import { defaultAgentSystemPrompt } from "~/domains/agents/agent-presets.ts";
import { deleteIngressRoutesByProject, upsertIngressRoute } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  ingressHostnameFromRequest,
  ingressUrlFromRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import {
  createProjectLifecycleProcessor,
  PROJECT_LIFECYCLE_STREAM_PATH,
  ProjectLifecycleProcessorContract,
  projectLifecycleEventTypes,
} from "~/domains/projects/stream-processors/project-lifecycle.ts";

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
  metadata: Record<string, unknown>;
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
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type ProjectStateRow = {
  id: string;
  slug: string;
  default_host: string;
  hosts_json: string;
  metadata_json: string;
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

export const PROJECT_CREATED_EVENT_TYPE = projectLifecycleEventTypes.projectCreated;

export class ProjectDurableObject extends ProjectBase<ProjectEnv> {
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
      metadata_json TEXT NOT NULL,
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
        (id, slug, default_host, hosts_json, metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        default_host = excluded.default_host,
        hosts_json = excluded.hosts_json,
        metadata_json = excluded.metadata_json,
        updated_at_ms = excluded.updated_at_ms`,
      input.projectId,
      input.slug,
      defaultHost,
      JSON.stringify(hosts.allHosts),
      JSON.stringify(input.metadata),
      now,
      now,
    );

    await upsertProjectProjection({
      db: this.env.DB,
      input,
    });
    await this.writeIngressRoutes({ hosts, projectId: input.projectId });
    const summary = this.requireSummary();
    await this.writeProjectCreatedLifecycleEvent(summary);
    await this.writeAgentsRootRule(summary);

    return summary;
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

  async getProjectLifecycleRunnerState() {
    await this.ensureStarted();
    return this.getStreamProcessorRunnerState();
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  async ingressFetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    const summary = this.requireSummary();
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

    return projectLandingResponse({ request, summary });
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

    for (const host of input.hosts.allHosts) {
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
    const row = this.getDurableObjectSql()
      .exec<ProjectStateRow>(
        `SELECT id, slug, default_host, hosts_json, metadata_json, created_at_ms, updated_at_ms
         FROM project_state
         LIMIT 1`,
      )
      .toArray()[0];

    if (!row) throw new Error("Project has not been created yet.");

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
      type: PROJECT_CREATED_EVENT_TYPE,
      idempotencyKey: `project-created:${summary.id}`,
      payload: {
        defaultHost: summary.defaultHost,
        hosts: summary.hosts,
        projectId: summary.id,
        slug: summary.slug,
      },
    });
  }

  private async ensureAgentsRoot(projectId: string) {
    await getOrInitializeDoStub({
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
        reactions: [
          {
            type: "append-events",
            events: `[
              {
                "streamPath": payload.childPath,
                "event": {
                  "type": "events.iterate.com/agent/system-prompt-updated",
                  "payload": {
                    "systemPrompt": ${JSON.stringify(defaultAgentSystemPrompt())}
                  },
                  "idempotencyKey": "agent-default-system-prompt-v2"
                }
              }
            ]`,
          },
        ],
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
}

type ProjectLifecycleStreamApi = ProcessorStreamApi<typeof ProjectLifecycleProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
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
      `INSERT INTO projects (id, slug, metadata, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(input.input.projectId, input.input.slug, JSON.stringify(input.input.metadata))
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
  const allHosts = [...projectHosts, ...mcpHosts];

  return {
    allHosts,
    defaultHost: normalizeIngressHost(`${input.slug}.${input.bases[0] ?? "iterate.localhost"}`),
    mcpHosts,
    projectHosts,
  };
}

function readLoopbackExports(ctx: DurableObjectState) {
  return ctx.exports;
}

function projectLandingResponse(input: { request: Request; summary: ProjectSummary }) {
  const url = ingressUrlFromRequest(input.request);
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.summary.slug)} project</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #fafafa; }
    main { max-width: 680px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { color: #525252; line-height: 1.5; }
    code { display: block; overflow-wrap: anywhere; white-space: pre-wrap; border-radius: 6px; background: #f5f5f5; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.summary.slug)}</h1>
    <p>This request reached the Project Durable Object for ${escapeHtml(url.host)}.</p>
    <code>${escapeHtml(input.summary.hosts.join("\n"))}</code>
  </main>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
