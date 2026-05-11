import { createD1Client } from "sqlfu";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
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
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
export { PROJECT_LIFECYCLE_STREAM_PATH } from "~/domains/projects/stream-processors/project-lifecycle.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";

const mockArtifactRepos = new Map<string, MockArtifactRepo>();

export class MockArtifactsBinding extends WorkerEntrypoint {
  async create(name: string) {
    if (mockArtifactRepos.has(name)) {
      throw new Error(`Artifact repo ${name} already exists.`);
    }

    const repo = new MockArtifactRepo(name);
    mockArtifactRepos.set(name, repo);
    return repo;
  }

  async get(name: string) {
    const repo = mockArtifactRepos.get(name);
    if (!repo) {
      throw new Error(`Artifact repo ${name} not found.`);
    }

    return repo;
  }
}

export class MockArtifactRepo extends RpcTarget {
  readonly artifactName: string;

  constructor(name: string) {
    super();
    this.artifactName = name;
  }

  defaultBranch() {
    return "main";
  }

  remote() {
    return `https://artifacts.example.test/${this.artifactName}.git`;
  }

  async createToken(scope: "read" | "write", ttlSeconds: number) {
    return {
      expiresAt: new Date(Date.UTC(2036, 0, 1)).toISOString(),
      plaintext: `mock-${scope}-${ttlSeconds}-${this.artifactName}`,
    };
  }

  async fork(name: string) {
    const repo = new MockArtifactRepo(name);
    mockArtifactRepos.set(name, repo);
    return repo;
  }
}

mockArtifactRepos.set("iterate-config-base", new MockArtifactRepo("iterate-config-base"));

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
