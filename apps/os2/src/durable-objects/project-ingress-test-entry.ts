import { createD1Client } from "sqlfu";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { PROJECT_LIFECYCLE_STREAM_PATH } from "~/domains/projects/stream-processors/project-lifecycle.ts";
import {
  getRepoDurableObjectName,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
export { PROJECT_LIFECYCLE_STREAM_PATH } from "~/domains/projects/stream-processors/project-lifecycle.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";

export default {
  async fetch(request, env, ctx) {
    await ensureD1Schema(env.DB);

    const url = new URL(request.url);
    if (url.pathname === "/__test/create-project") {
      const project = await env.PROJECT.getByName(
        getProjectDurableObjectName("proj_local_test"),
      ).createProject({
        metadata: {},
        projectId: "proj_local_test",
        slug: "demo",
      });

      return Response.json(project);
    }

    if (url.pathname === "/__test/upsert-secret") {
      const secret = await ctx.exports
        .OrpcCapability({ props: { projectId: "proj_local_test" } })
        .executeCodemodeFunctionCall({
          args: [
            {
              key: url.searchParams.get("key") ?? "openai",
              material: url.searchParams.get("material") ?? "mvp-secret-value",
            },
          ],
          codemodeSessionCapability: {
            async callFunction() {
              throw new Error("Project ingress tests do not route nested codemode calls.");
            },
          },
          functionCallId: crypto.randomUUID(),
          functionPath: ["secrets", "upsert"],
          invocationKind: "rpc",
          path: ["PROJECT", "orpc", "secrets", "upsert"],
          providerPath: ["PROJECT", "orpc"],
        });
      return Response.json(secret);
    }

    if (url.pathname === "/__test/set-external-egress-proxy-url") {
      await env.DB.prepare(`UPDATE projects SET external_egress_proxy_url = ? WHERE id = ?`)
        .bind(url.searchParams.get("url"), "proj_local_test")
        .run();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/__test/egress") {
      const target = url.searchParams.get("target") ?? "https://os.iterate.localhost/__test/echo";
      return await env.PROJECT.getByName(
        getProjectDurableObjectName("proj_local_test"),
      ).egressFetch(
        new Request(target, {
          headers: request.headers,
        }),
      );
    }

    if (url.pathname === "/__test/echo" || url.pathname.startsWith("/__test/proxy/")) {
      return Response.json({
        headers: Object.fromEntries(request.headers),
        url: request.url,
      });
    }

    if (url.pathname === "/__test/project-stream") {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj_local_test",
        path: PROJECT_LIFECYCLE_STREAM_PATH,
      });

      return Response.json({ events: await stream.history({ before: "end" }) });
    }

    if (url.pathname === "/__test/project-lifecycle-state") {
      const state = await env.PROJECT.getByName(
        getProjectDurableObjectName("proj_local_test"),
      ).getProjectLifecycleRunnerState();
      return Response.json(state);
    }

    if (url.pathname === "/__test/iterate-config-repo") {
      const repo = await env.REPO.getByName(
        getRepoDurableObjectName({
          projectId: "proj_local_test",
          repoSlug: ITERATE_CONFIG_REPO_SLUG,
        }),
      ).getInfo();

      return Response.json(repo satisfies RepoInfo);
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
        exports: ctx.exports,
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
        updated_at text not null default current_timestamp,
        external_egress_proxy_url text
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
    db.prepare(`CREATE TABLE IF NOT EXISTS project_secrets (
      id text primary key not null,
      project_id text not null references projects (id) on delete cascade,
      key text not null,
      material text not null,
      metadata text not null check (json_valid(metadata)),
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique (project_id, key)
    )`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_project_secrets_project_id ON project_secrets (project_id)`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_project_secrets_key ON project_secrets (key)`),
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
