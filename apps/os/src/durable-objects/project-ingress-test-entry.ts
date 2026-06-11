import { RpcTarget } from "cloudflare:workers";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import {
  getProjectDurableObjectName,
  ProjectDurableObject as RealProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import { PROJECT_STREAM_PATH } from "~/domains/projects/stream-processors/project/contract.ts";
import {
  getRepoDurableObjectName,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
} from "~/ingress/host-routing.ts";
import { lookupIngressRule } from "~/ingress/lookup.ts";
import { resolveItx } from "~/itx/entrypoint.ts";

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

  // The config worker is a stream processor: every project root-stream event
  // is forwarded here. Echo pings back as facts so tests can observe the
  // whole forwarding chain end to end.
  async processEvent({ event, streamPath }, env) {
    if (streamPath !== "/") return;
    if (event.type !== "test.project/ping") return;
    await env.STREAMS.append({
      streamPath: "/config-worker-saw",
      event: {
        type: "test.project/config-worker-saw",
        payload: { pingOffset: event.offset, n: event.payload.n },
      },
    });
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
  protected override async cloneWorkerRepo(input: {
    git: TestProjectConfigGit;
    repo: RepoInfo;
    workspace: TestProjectConfigWorkspace;
  }) {
    if (!input.repo.remote.startsWith(MOCK_ARTIFACT_REMOTE_BASE)) {
      await super.cloneWorkerRepo(input);
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

  protected override async bundleWorkerCode(files: Record<string, string>) {
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
export { OrpcCapability } from "~/rpc-targets/os-capabilities.ts";
export { ItxEntrypoint, ProjectEgress } from "~/itx/entrypoint.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";
export { PROJECT_STREAM_PATH } from "~/domains/projects/stream-processors/project/contract.ts";
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
      // Match the production callers (project directory, itx.projects.create):
      // they insert the projects row BEFORE dialing the DO, because
      // createProject returns immediately and the processor's own projection
      // upsert is eventually consistent.
      await env.DB.prepare(
        `INSERT INTO projects (id, slug) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
      )
        .bind(projectId, slug)
        .run();
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
        .call({
          args: [
            {
              key: url.searchParams.get("key") ?? "openai",
              material: url.searchParams.get("material") ?? "mvp-secret-value",
            },
          ],
          path: ["secrets", "upsert"],
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

    if (url.pathname === "/__test/egress-with-fetch-shadow") {
      // The same user story the deleted egress intercept tunnel served:
      // a LIVE `fetch` cap shadows the project's egress capability and sees
      // getSecret() placeholders UNSUBSTITUTED (substitution lives in the
      // default pipe). Live stubs passed over Workers RPC only survive the
      // defining request, so define → fetch → revoke happen in one go —
      // exactly the session-bound semantics live caps are designed around.
      class EchoEgressShadow extends RpcTarget {
        async call({ args }: { path: string[]; args: unknown[] }) {
          const request = args[0] as Request;
          return Response.json({
            headers: headersToArrays(request.headers),
            url: request.url,
          });
        }
      }
      const itx = await resolveItx({
        env: env as never,
        exports: ctx.exports as never,
        props: { context: "proj__local__test" },
      });
      await itx.define({
        invoke: "path-call",
        name: "fetch",
        target: new EchoEgressShadow() as never,
      });
      try {
        const target = url.searchParams.get("target") ?? "https://api.example.com/v1/models";
        const response = await itx.fetch(new Request(target, { headers: request.headers }));
        return Response.json(await response.json());
      } finally {
        await itx.revoke({ name: "fetch" });
      }
    }

    if (url.pathname === "/__test/echo" || url.pathname.startsWith("/__test/proxy/")) {
      return Response.json({
        headers: Object.fromEntries(request.headers),
        url: request.url,
      });
    }

    if (url.pathname === "/__test/append-project-event") {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj__local__test",
        path: PROJECT_STREAM_PATH,
      });
      const n = Number(url.searchParams.get("n") ?? "0");
      const appended = await stream.append({ type: "test.project/ping", payload: { n } });
      return Response.json({ appended });
    }

    if (url.pathname === "/__test/read-stream") {
      const path = url.searchParams.get("path") ?? PROJECT_STREAM_PATH;
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj__local__test",
        path: StreamPath.parse(path),
      });
      return Response.json({ events: await stream.history({ before: "end" }) });
    }

    if (url.pathname === "/__test/project-stream") {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj__local__test",
        path: PROJECT_STREAM_PATH,
      });

      return Response.json({ events: await stream.history({ before: "end" }) });
    }

    if (url.pathname === "/__test/global-projects-stream") {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "global",
        path: StreamPath.parse("/projects"),
      });

      return Response.json({ events: await stream.history({ before: "end" }) });
    }

    if (url.pathname === "/__test/itx-project-processor-phase") {
      // Regression: itx.project is a path proxy, so deep property traversal
      // works in ONE expression — including through the handle's fallthrough
      // Proxy, which must NOT bind getter results (the path proxy reserves
      // "bind" as a path segment; binding it produced "value.bind is not a
      // function").
      const itx = await resolveItx({
        env: env as never,
        exports: ctx.exports as never,
        props: { context: "proj__local__test" },
      });
      const project = itx.project as unknown as {
        processor: { snapshot(): Promise<{ state: { phase: string } }> };
      };
      const snapshot = await project.processor.snapshot();
      return Response.json({ phase: snapshot.state.phase });
    }

    if (url.pathname === "/__test/append-spoofed-create") {
      // A crafted create-requested naming ANOTHER project: the processor
      // must ignore it (see ProjectProcessor #ownEvent).
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj__local__test",
        path: PROJECT_STREAM_PATH,
      });
      const appended = await stream.append({
        type: "events.iterate.com/project/create-requested",
        payload: { projectId: "proj__local__evil", slug: "evil" },
      });
      return Response.json({ offset: appended.offset });
    }

    if (url.pathname === "/__test/project-state") {
      // Raw Workers stub: await the `processor` getter before calling —
      // workerd does not pipeline calls through property accesses. (itx
      // handles wrap the stub in a path proxy, so over itx the one-expression
      // `itx.project.processor.snapshot()` spelling works.)
      const project = env.PROJECT.getByName(
        getProjectDurableObjectName("proj__local__test"),
      ) as unknown as ProjectStateRpc;
      const processor = await project.processor;
      return Response.json(await processor.snapshot());
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

    const ingressMatch = await matchIngressRequest({
      request,
      lookupRule: (host) =>
        lookupIngressRule({
          appHostname: "os.iterate.localhost",
          db: env.DB,
          host,
          projectHostnameBases: ["iterate.localhost"],
        }),
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

type ProjectStateRpc = {
  processor: { snapshot(): Promise<unknown> };
};

async function ensureD1Schema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
        id text primary key not null,
        slug text not null unique,
        custom_hostname text unique,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      )`),
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
  ]);
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
