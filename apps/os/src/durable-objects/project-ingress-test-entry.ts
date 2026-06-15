import { RpcTarget } from "cloudflare:workers";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { PROJECT_STREAM_PATH } from "~/domains/projects/stream-processors/project/contract.ts";
import {
  getRepoDurableObjectName,
  RepoDurableObject as RealRepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import type { CommitRepoFilesInput, CommitRepoFilesResult } from "~/domains/repos/repo-git.ts";
import { PROJECT_REPO_SLUG } from "~/domains/repos/project-repo.ts";
import { PROJECT_REPO_AGENTS_MD } from "~/domains/repos/project-repo-template.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
} from "~/ingress/host-routing.ts";
import { lookupIngressRule } from "~/ingress/lookup.ts";
import { resolveItx } from "~/itx/entrypoint.ts";
import { PROJECT_WORKER_SOURCE } from "~/itx/platform-context.ts";
import { repoSourceMemoKey } from "~/itx/source-build.ts";

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

// A deterministic fake head commit for the mock remote — any 40-hex oid.
const MOCK_TREE_COMMIT = "feedc0de".repeat(5);

export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";

/**
 * The mock seam moved to where the dependency actually is: the mock artifact
 * remote serves no git protocol, so the repo DO's checkout surface answers
 * from in-memory sources instead. Everything downstream — resolveWorkerSource,
 * the R2 build memo, the REAL @cloudflare/worker-bundler multi-file bundle,
 * the loader — runs for real.
 */
export class RepoDurableObject extends RealRepoDurableObject {
  override async commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    if (!(await this.#isMockRemote())) return super.commitFiles(input);
    return {
      branch: input.branch ?? "main",
      changedPaths: input.changes.map((change) => change.path),
      commitOid: MOCK_TREE_COMMIT,
      createdBranch: false,
      noChanges: false,
    };
  }

  override async readTree(input = {}) {
    if (!(await this.#isMockRemote())) return super.readTree(input);
    return {
      commitOid: MOCK_TREE_COMMIT,
      files: [
        { content: TEST_APP_ONE_WORKER_SOURCE, path: "apps/app1/worker.js" },
        { content: TEST_APP_TWO_WORKER_SOURCE, path: "apps/app2/worker.js" },
        { content: PROJECT_REPO_AGENTS_MD, path: "AGENTS.md" },
        { content: '{\n  "version": 1\n}\n', path: "iterate.config.jsonc" },
        { content: '{\n  "type": "module"\n}\n', path: "package.json" },
        { content: TEST_PROJECT_WORKER_SOURCE, path: "worker.js" },
      ],
    };
  }

  override async headOid(input = {}) {
    if (!(await this.#isMockRemote())) return super.headOid(input);
    return { oid: MOCK_TREE_COMMIT };
  }

  async #isMockRemote() {
    try {
      const info = await this.getInfo();
      return info.remote.startsWith(MOCK_ARTIFACT_REMOTE_BASE);
    } catch (error) {
      if (error instanceof Error && error.name === "NotInitializedError") {
        return true;
      }
      throw error;
    }
  }
}
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { StreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
export { EgressPipe, ItxEntrypoint, ProjectEgress } from "~/itx/entrypoint.ts";
export { ItxDurableObject } from "~/itx/itx-durable-object.ts";
export { PlatformContext } from "~/itx/platform-context.ts";
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
      // Pre-seed the R2 build memo for the mock commit: the REAL bundler
      // cannot run under vitest-pool-workers (its internal esbuild.wasm
      // import doesn't resolve in the test module runner), so the memo-hit
      // path is what these tests exercise — the loader still consumes the
      // multi-module output for real. Bundler-in-workerd is covered by the
      // itx e2e litmus against deployed environments.
      await env.ITX_BUILD_CACHE.put(
        await repoSourceMemoKey({
          oid: MOCK_TREE_COMMIT,
          projectId,
          source: PROJECT_WORKER_SOURCE,
        }),
        JSON.stringify({
          mainModule: "worker.js",
          modules: {
            "apps/app1/worker.js": TEST_APP_ONE_WORKER_SOURCE,
            "apps/app2/worker.js": TEST_APP_TWO_WORKER_SOURCE,
            "worker.js": TEST_PROJECT_WORKER_SOURCE,
          },
        }),
      );
      if (customHostname) {
        await env.DB.prepare(`UPDATE projects SET custom_hostname = ? WHERE id = ?`)
          .bind(normalizeIngressHost(customHostname), projectId)
          .run();
      }

      return Response.json(project);
    }

    if (url.pathname === "/__test/upsert-secret") {
      const secrets = getSecretsCapability({
        exports: ctx.exports,
        props: { projectId: "proj__local__test" },
      });
      const secret = await secrets.setSecret({
        key: url.searchParams.get("key") ?? "openai",
        material: url.searchParams.get("material") ?? "mvp-secret-value",
      });
      return Response.json(secret);
    }

    if (url.pathname === "/__test/egress") {
      // The explicit door: itx.fetch dispatches the `fetch` capability, whose
      // default target is the stateless EgressPipe (the DO has no fetch
      // surface at all).
      const target = url.searchParams.get("target") ?? "https://os.iterate.localhost/__test/echo";
      const itx = await resolveItx({
        env: env as never,
        exports: ctx.exports as never,
        props: { context: "proj__local__test:/" },
      });
      return await itx.fetch(target, { headers: request.headers });
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
        props: { context: "proj__local__test:/" },
      });
      await itx.provideCapability({
        name: "fetch",
        capability: new EchoEgressShadow() as never,
      });
      try {
        const target = url.searchParams.get("target") ?? "https://api.example.com/v1/models";
        const response = await itx.fetch(new Request(target, { headers: request.headers }));
        return Response.json(await response.json());
      } finally {
        await itx.revokeCapability({ name: "fetch" });
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

    if (url.pathname === "/__test/append-onboarding-completed") {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
        namespace: "proj__local__test",
        path: PROJECT_STREAM_PATH,
      });
      const appended = await stream.append({
        type: "events.iterate.com/project/onboarding-completed",
        payload: {
          agentPath: "/agents/onboarding",
          commitOid: MOCK_TREE_COMMIT,
          projectId: "proj__local__test",
        },
      });
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
        props: { context: "proj__local__test:/" },
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

    if (url.pathname === "/__test/project-repo") {
      const repo = await env.REPO.getByName(
        getRepoDurableObjectName({
          projectId: "proj__local__test",
          repoSlug: PROJECT_REPO_SLUG,
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

function headersToArrays(headers: Headers) {
  return Object.fromEntries([...headers].map(([key, value]) => [key, [value]]));
}
