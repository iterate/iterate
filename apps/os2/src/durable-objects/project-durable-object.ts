import { createD1Client } from "sqlfu";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { typeid } from "@iterate-com/shared/typeid";
import { createCodemodePresetSeeds } from "~/codemode/preset-seeds.ts";
import { AppConfig } from "~/app.ts";
import { deleteIngressRoutesByProject, upsertIngressRoute } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  ingressHostnameFromRequest,
  ingressUrlFromRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

export type ProjectInitParams = {
  name: string;
  projectId: string;
  clerkOrgId: string;
  createdByClerkUserId: string;
};

export type ProjectSummary = {
  id: string;
  slug: string;
  clerkOrgId: string;
  createdByClerkUserId: string;
  defaultHost: string;
  hosts: string[];
};

export type CreateProjectInput = {
  projectId: string;
  slug: string;
  clerkOrgId: string;
  createdByClerkUserId: string;
  metadata: Record<string, unknown>;
};

export type ProjectAccessPrincipal = {
  orgId: string;
  userId: string;
};

type ProjectEnv = {
  APP_CONFIG: string;
  DB: D1Database;
  DO_CATALOG: D1Database;
};

type ProjectStateRow = {
  id: string;
  slug: string;
  clerk_org_id: string;
  created_by_clerk_user_id: string;
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

const ProjectBase = createIterateDurableObjectBase<
  ProjectInitParams,
  Pick<ProjectEnv, "DO_CATALOG">
>({
  className: "ProjectDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    clerkOrgId: (params) => params.clerkOrgId,
    projectId: (params) => params.projectId,
  },
});

export class ProjectDurableObject extends ProjectBase<ProjectEnv> {
  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    const sql = this.getDurableObjectSql();
    sql.exec(`CREATE TABLE IF NOT EXISTS project_state (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      clerk_org_id TEXT NOT NULL,
      created_by_clerk_user_id TEXT NOT NULL,
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
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    await this.initialize({
      name: input.projectId,
      projectId: input.projectId,
      clerkOrgId: input.clerkOrgId,
      createdByClerkUserId: input.createdByClerkUserId,
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
        (id, slug, clerk_org_id, created_by_clerk_user_id, default_host, hosts_json, metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        clerk_org_id = excluded.clerk_org_id,
        created_by_clerk_user_id = excluded.created_by_clerk_user_id,
        default_host = excluded.default_host,
        hosts_json = excluded.hosts_json,
        metadata_json = excluded.metadata_json,
        updated_at_ms = excluded.updated_at_ms`,
      input.projectId,
      input.slug,
      input.clerkOrgId,
      input.createdByClerkUserId,
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
    await this.seedPresets(input.projectId);

    return this.requireSummary();
  }

  async checkAccess(input: { principal: ProjectAccessPrincipal }): Promise<ProjectSummary> {
    await this.ensureStarted();
    const summary = this.requireSummary();
    const row = await this.env.DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND clerk_org_id = ? LIMIT 1`,
    )
      .bind(summary.id, input.principal.orgId)
      .first<{ id: string }>();

    if (!row) {
      throw new Error(`Project ${summary.id} is not available to this principal.`);
    }

    return summary;
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
    const config = this.getAppConfig();
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

    for (const host of input.hosts.streamsHosts) {
      const callable = {
        type: "fetch",
        via: {
          type: "url",
          url: config.projectStreamsEventsBaseUrl,
        },
        fetchRequest: {
          headers: {
            "x-iterate-project-id": input.projectId,
          },
        },
      } satisfies FetchCallable;
      this.writeLocalRoute({
        callable,
        host,
        notes: "Project events stream host",
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

  private async seedPresets(projectId: string) {
    const workerScriptName = this.getAppConfig().deployment?.workerScriptName;
    if (!workerScriptName) throw new Error("AppConfig deployment.workerScriptName is required.");

    for (const seed of createCodemodePresetSeeds({ workerScriptName })) {
      await this.env.DB.prepare(
        `INSERT INTO project_presets (id, project_id, name, description, events_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, name) DO NOTHING`,
      )
        .bind(
          this.createTypeId("preset"),
          projectId,
          seed.name,
          seed.description,
          JSON.stringify(seed.events),
        )
        .run();
    }
  }

  private requireSummary(): ProjectSummary {
    const row = this.getDurableObjectSql()
      .exec<ProjectStateRow>(
        `SELECT id, slug, clerk_org_id, created_by_clerk_user_id, default_host, hosts_json, metadata_json, created_at_ms, updated_at_ms
         FROM project_state
         LIMIT 1`,
      )
      .toArray()[0];

    if (!row) throw new Error("Project has not been created yet.");

    return {
      id: row.id,
      slug: row.slug,
      clerkOrgId: row.clerk_org_id,
      createdByClerkUserId: row.created_by_clerk_user_id,
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
}

async function upsertProjectProjection(input: { db: D1Database; input: CreateProjectInput }) {
  const row = await input.db
    .prepare(
      `INSERT INTO projects (id, slug, clerk_org_id, created_by_clerk_user_id, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        clerk_org_id = excluded.clerk_org_id,
        created_by_clerk_user_id = excluded.created_by_clerk_user_id,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(
      input.input.projectId,
      input.input.slug,
      input.input.clerkOrgId,
      input.input.createdByClerkUserId,
      JSON.stringify(input.input.metadata),
    )
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
  const streamsHosts = input.bases.flatMap((base) => [
    normalizeIngressHost(`streams.${input.slug}.${base}`),
    normalizeIngressHost(`streams.${input.projectId}.${base}`),
    normalizeIngressHost(`streams__${input.slug}.${base}`),
    normalizeIngressHost(`streams__${input.projectId}.${base}`),
  ]);
  const allHosts = [...projectHosts, ...mcpHosts, ...streamsHosts];

  return {
    allHosts,
    defaultHost: normalizeIngressHost(`${input.slug}.${input.bases[0] ?? "iterate.localhost"}`),
    mcpHosts,
    projectHosts,
    streamsHosts,
  };
}

function readLoopbackExports(ctx: DurableObjectState) {
  return (ctx as DurableObjectState & { exports?: Record<string, unknown> }).exports;
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
