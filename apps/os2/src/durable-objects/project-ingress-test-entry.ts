import { createD1Client } from "sqlfu";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

export { ProjectDurableObject } from "./project-durable-object.ts";
export { ProjectMcpServerConnection } from "./project-mcp-server-connection.ts";
export { ProjectIngressEntrypoint } from "~/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/entrypoints/project-mcp-server-entrypoint.ts";

export default {
  async fetch(request, env, ctx) {
    await ensureD1Schema(env.DB);

    const url = new URL(request.url);
    if (url.pathname === "/__test/create-project") {
      const project = await env.PROJECT.getByName("proj_local_test").createProject({
        metadata: {},
        projectId: "proj_local_test",
        slug: "demo",
      });

      return Response.json(project);
    }

    const db = createD1Client(env.DB);
    const ingressMatch = await matchIngressRequest({
      request,
      lookupRule: async (host) => {
        const row = await getIngressRouteByHost(db, { host: normalizeIngressHost(host) });
        return row ? ingressRouteRowToRule(row) : null;
      },
    });

    if (!ingressMatch) {
      return new Response("No ingress route matched.", { status: 404 });
    }

    return await dispatchFetchCallable({
      callable: ingressMatch.rule.callable,
      context: {
        env: env as unknown as Record<string, unknown>,
        exports: (ctx as ExecutionContext & { exports?: Record<string, unknown> }).exports,
      },
      request,
    });
  },
} satisfies ExportedHandler<Env>;

async function ensureD1Schema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
        id text primary key not null,
        slug text not null unique,
        custom_hostname text unique,
        metadata text not null check (json_valid(metadata)),
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_permissions (
        project_id text not null references projects (id) on delete cascade,
        principal_type text not null check (principal_type in ('clerk_organization')),
        principal_id text not null,
        role text not null check (role in ('owner')),
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp,
        primary key (project_id, principal_type, principal_id)
      )`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_project_permissions_project_id ON project_permissions (project_id)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_project_permissions_principal ON project_permissions (principal_type, principal_id)`,
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_presets (
      id text primary key not null,
      project_id text not null references projects (id) on delete cascade,
      name text not null,
      description text,
      events_json text not null check (json_valid(events_json)),
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique (project_id, name)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ingress_routes (
      id text primary key not null,
      host text not null unique,
      project_id text references projects (id) on delete cascade,
      priority integer not null,
      notes text,
      callable_json text not null check (json_valid(callable_json)),
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ingress_routes_host ON ingress_routes (host)`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ingress_routes_project_id ON ingress_routes (project_id)`,
    ),
  ]);
}

function ingressRouteRowToRule(row: {
  id: string;
  host: string;
  project_id?: string | null;
  priority: number;
  notes?: string | null;
  callable_json: string;
  created_at: string;
  updated_at: string;
}): ExactHostIngressRule {
  return {
    id: row.id,
    host: row.host,
    projectId: row.project_id ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    callable: parseIngressCallable(row.callable_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
