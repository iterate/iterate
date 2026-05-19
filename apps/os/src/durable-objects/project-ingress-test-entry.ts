import { createD1Client } from "sqlfu";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import {
  getProjectDurableObjectName,
  ProjectDurableObject as RealProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
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
import { getProjectCustomHostnameIngressRule } from "~/ingress/project-custom-hostname-routing.ts";
import { getProjectPlatformHostIngressRule } from "~/ingress/project-platform-host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

const PROJECT_CONFIG_DIR = "/iterate-config";
const MOCK_ARTIFACT_REMOTE_BASE = "https://artifacts.example.test/";
const TEST_PROJECT_WORKER_SOURCE = `import app1 from "./apps/app1/worker.js";
import app2 from "./apps/app2/worker.js";

const apps = [app1, app2];

export default {
  async fetch(request) {
    for (const app of apps) {
      const response = await app.fetch(request);
      if (response) return response;
    }

    return new Response("Bundled project worker");
  },
};
`;
const TEST_APP_ONE_WORKER_SOURCE = `export default {
  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "app1") return;
    return new Response("hello from app one");
  },
};
`;
const TEST_APP_TWO_WORKER_SOURCE = `export default {
  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "app2") return;
    return new Response("hello from app two");
  },
};
`;

type TestProjectConfigGit = {
  add(input: { dir: string; filepath: string }): Promise<unknown>;
  clone(input: Record<string, unknown>): Promise<unknown>;
  commit(input: {
    author: { email: string; name: string };
    dir: string;
    message: string;
  }): Promise<unknown>;
  init(input: { defaultBranch: string; dir: string }): Promise<unknown>;
  log(input: { depth: number; dir: string; ref: string }): Promise<Array<{ oid: string }>>;
  pull(input: Record<string, unknown>): Promise<unknown>;
  status(input: { dir: string }): Promise<unknown>;
};

type TestProjectConfigWorkspace = {
  cloudflareShellGit(): Promise<unknown>;
  cloudflareShellState(): Promise<Record<string, unknown>>;
  hasFile(path: string): Promise<boolean>;
  initialize(input: { name: string }): Promise<unknown>;
  removePath(input: { force: boolean; path: string; recursive: boolean }): Promise<void>;
};

export class ProjectDurableObject extends RealProjectDurableObject {
  installTestProjectEgressInterceptTunnel() {
    this.replaceProjectEgressInterceptTunnel({
      fetch(request: Request) {
        return Response.json({
          headers: headersToArrays(request.headers),
          url: request.url,
        });
      },
      [Symbol.dispose]() {},
    });
  }

  protected async cloneProjectConfigRepo(input: {
    git: TestProjectConfigGit;
    repo: RepoInfo;
    workspace: TestProjectConfigWorkspace;
  }) {
    if (!input.repo.remote.startsWith(MOCK_ARTIFACT_REMOTE_BASE)) {
      await super.cloneProjectConfigRepo(input);
      return;
    }

    const state = await input.workspace.cloudflareShellState();
    const writeFile = readWorkspaceStateMethod({ method: "writeFile", state });
    await writeFile(`${PROJECT_CONFIG_DIR}/iterate.config.jsonc`, '{\n  "version": 1\n}\n');
    await writeFile(`${PROJECT_CONFIG_DIR}/package.json`, '{\n  "type": "module"\n}\n');
    await writeFile(`${PROJECT_CONFIG_DIR}/worker.js`, TEST_PROJECT_WORKER_SOURCE);
    await writeFile(`${PROJECT_CONFIG_DIR}/apps/app1/worker.js`, TEST_APP_ONE_WORKER_SOURCE);
    await writeFile(`${PROJECT_CONFIG_DIR}/apps/app2/worker.js`, TEST_APP_TWO_WORKER_SOURCE);
    await input.git.init({ dir: PROJECT_CONFIG_DIR, defaultBranch: input.repo.defaultBranch });
    await input.git.add({ dir: PROJECT_CONFIG_DIR, filepath: "iterate.config.jsonc" });
    await input.git.add({ dir: PROJECT_CONFIG_DIR, filepath: "package.json" });
    await input.git.add({ dir: PROJECT_CONFIG_DIR, filepath: "worker.js" });
    await input.git.add({ dir: PROJECT_CONFIG_DIR, filepath: "apps/app1/worker.js" });
    await input.git.add({ dir: PROJECT_CONFIG_DIR, filepath: "apps/app2/worker.js" });
    await input.git.commit({
      dir: PROJECT_CONFIG_DIR,
      message: "Seed test iterate config worker",
      author: {
        name: "Iterate",
        email: "support@iterate.com",
      },
    });
  }

  protected override async bundleProjectDynamicWorkerCode(files: Record<string, string>) {
    if (typeof files["package.json"] !== "string") {
      throw new Error("Test project worker bundler path requires package.json.");
    }
    if (typeof files["apps/app1/worker.js"] !== "string") {
      throw new Error("Test project worker bundler path requires apps/app1/worker.js.");
    }
    if (typeof files["apps/app2/worker.js"] !== "string") {
      throw new Error("Test project worker bundler path requires apps/app2/worker.js.");
    }

    return {
      compatibilityDate: "2026-04-27",
      compatibilityFlags: ["nodejs_compat"],
      globalOutbound: null,
      mainModule: "worker.js",
      modules: {
        "worker.js": {
          js: TEST_PROJECT_WORKER_SOURCE,
        },
        "apps/app1/worker.js": {
          js: TEST_APP_ONE_WORKER_SOURCE,
        },
        "apps/app2/worker.js": {
          js: TEST_APP_TWO_WORKER_SOURCE,
        },
      },
    };
  }
}
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
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
      const projectId = url.searchParams.get("projectId") ?? "proj__local__test";
      const slug = url.searchParams.get("slug") ?? "demo";
      const customHostname = url.searchParams.get("customHostname");
      const project = await env.PROJECT.getByName(
        getProjectDurableObjectName(projectId),
      ).createProject({
        projectId,
        slug,
      });
      if (customHostname) {
        await env.DB.prepare(`UPDATE projects SET custom_hostname = ? WHERE id = ?`)
          .bind(normalizeIngressHost(customHostname), projectId)
          .run();
      }

      return Response.json(project);
    }

    if (url.pathname === "/__test/upsert-secret") {
      const secret = await ctx.exports
        .OrpcCapability({ props: { projectId: "proj__local__test" } })
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

    if (url.pathname === "/__test/egress") {
      const target = url.searchParams.get("target") ?? "https://os.iterate.localhost/__test/echo";
      return await env.PROJECT.getByName(
        getProjectDurableObjectName("proj__local__test"),
      ).egressFetch(
        new Request(target, {
          headers: request.headers,
        }),
      );
    }

    if (url.pathname === "/__test/connect-egress-intercept") {
      const project = env.PROJECT.getByName(
        getProjectDurableObjectName("proj__local__test"),
      ) as DurableObjectStub<ProjectDurableObject>;
      await project.installTestProjectEgressInterceptTunnel();
      return Response.json({ ok: true });
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
        namespace: "proj__local__test",
        path: PROJECT_LIFECYCLE_STREAM_PATH,
      });

      return Response.json({ events: await stream.history({ before: "end" }) });
    }

    if (url.pathname === "/__test/project-lifecycle-state") {
      const state = await env.PROJECT.getByName(
        getProjectDurableObjectName("proj__local__test"),
      ).getProjectLifecycleRunnerState();
      return Response.json(state);
    }

    if (url.pathname === "/__test/iterate-config-repo") {
      const repo = await env.REPO.getByName(
        getRepoDurableObjectName({
          projectId: "proj__local__test",
          repoSlug: ITERATE_CONFIG_REPO_SLUG,
        }),
      ).getInfo();

      return Response.json(repo satisfies RepoInfo);
    }

    const db = createD1Client(env.DB);
    const appHostname = "os.iterate.localhost";
    const projectHostnameBases = ["iterate.localhost"];
    const ingressMatch = await matchIngressRequest({
      request,
      lookupRule: async (host) => {
        const row = await getIngressRouteByHost(db, { host: normalizeIngressHost(host) });
        if (row) return ingressRouteRowToRule(row);

        const platformRule = await getProjectPlatformHostIngressRule({
          appHostname,
          bases: projectHostnameBases,
          db: env.DB,
          host,
        });
        if (platformRule) return platformRule;

        return await getProjectCustomHostnameIngressRule({
          appHostname,
          db: env.DB,
          host,
        });
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

function readWorkspaceStateMethod(input: { method: string; state: Record<string, unknown> }) {
  const method = input.state[input.method];
  if (typeof method !== "function") {
    throw new Error(`Workspace state does not implement ${input.method}.`);
  }
  return method;
}

function headersToArrays(headers: Headers) {
  return Object.fromEntries([...headers].map(([key, value]) => [key, [value]]));
}
