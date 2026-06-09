import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import dedent from "dedent";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebClient } from "@slack/web-api";
import { Redacted } from "@iterate-com/shared/apps/config";
import {
  createAdminOsClient,
  requireBaseUrl,
  requireRootAccessToken,
  uniqueSuffix,
} from "../../../e2e/test-support/os-client.ts";
import { createPublicTunnel } from "../../../e2e/test-support/create-test-project.ts";
import type { ProjectCapability } from "../../domains/projects/durable-objects/project-durable-object.ts";
import type { IterateContext } from "../iterate-context-capability.ts";
import { liftLocalProxies, localProxyCaller } from "../local-proxy-wrapper.js";

const baseUrl = requireBaseUrl();
const auth = rootAccessAuth();
const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";
const SLACK_SECRET_KEY = "slack-api-key";
const SLACK_SECRET_MATERIAL = "this-should-arrive-in-our-fake-slack-api-captun-tunnel";

describe("capnweb Slack SDK mount proof", () => {
  const slugPrefix = `captnweb-slack-${crypto.randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    using projects = await root.projects;
    const page = await projects.list({ limit: 1_000 });
    for (const project of page.projects.filter((candidate) =>
      candidate.slug.startsWith(slugPrefix),
    )) {
      await projects.remove({ id: project.id }).catch(() => undefined);
    }
  });

  it("lets an iterate-config tool call ctx.slack.chat.postMessage through a test-owned Slack SDK target", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${slugPrefix}-${uniqueSuffix()}`.slice(0, 40),
    });
    const os = createAdminOsClient(baseUrl);
    await os.project.secrets.upsert({
      key: SLACK_SECRET_KEY,
      material: SLACK_SECRET_MATERIAL,
      projectSlugOrId: project.slug,
    });

    const receivedSlackRequests: FakeSlackRequest[] = [];
    using fakeSlack = await createPublicTunnel({
      fetch: async (request) => {
        const bodyText = await request.text();
        receivedSlackRequests.push({
          body: bodyText,
          headers: Object.fromEntries(request.headers),
          method: request.method,
          url: request.url,
        });
        return Response.json(
          {
            channel: "CFAKE",
            message: { text: new URLSearchParams(bodyText).get("text") },
            ok: true,
            ts: "1770000000.000100",
          },
          { headers: { "content-type": "application/json" } },
        );
      },
      tunnelName: `fake-slack-${uniqueSuffix()}`,
    });

    const connectionKey = `slack-sdk-${uniqueSuffix()}`;
    const workerSource = slackConfigWorkerSource({ connectionKey, projectId: project.id });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });

    await runCodemodeWithProjectEgressFetch(iterate.ctx, project.id, async () => {
      using projects = await iterate.ctx.projects;
      using projectContext = await projects.get(project.id);
      await projectContext.provideCapability({
        connectionKey,
        rpcTarget: new SlackSdkRpcTarget({
          slackApiUrl: `${fakeSlack.url}/api/`,
          token: `getSecret({ key: ${JSON.stringify(SLACK_SECRET_KEY)} })`,
        }),
      });

      await updateIterateConfigWorker({
        ctx: iterate.ctx,
        dir: `/iterate-config-slack-${Date.now()}`,
        projectId: project.id,
        workerSource,
      });

      using worker = (await projectContext.worker) as any;
      const result = await worker.postDailyReport({
        channel: "CFAKE",
        text: "daily report from iterate-config",
      });
      expect(result).toMatchObject({
        channel: "CFAKE",
        ok: true,
        ts: "1770000000.000100",
      });
    });

    expect(receivedSlackRequests).toHaveLength(1);
    const [request] = receivedSlackRequests;
    expect(new URL(request.url).pathname).toMatch(/\/api\/chat\.postMessage$/);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${SLACK_SECRET_MATERIAL}`);
    expect(Object.fromEntries(new URLSearchParams(request.body))).toMatchObject({
      channel: "CFAKE",
      text: "daily report from iterate-config",
    });
  });
});

class SlackSdkRpcTarget extends RpcTarget {
  readonly #client: WebClient;

  constructor(input: { slackApiUrl: string; token: string }) {
    super();
    this.#client = new WebClient(input.token, {
      adapter: slackAxiosAdapter,
      retryConfig: { retries: 0 },
      slackApiUrl: input.slackApiUrl,
    });
  }

  sdk() {
    // This is the server-side half of the Slack-style infinite SDK path. The
    // caller sees ctx.slack.chat.postMessage(...); localProxyCaller records
    // ["chat", "postMessage"] and forwards it here as call({ path, args }).
    return localProxyCaller(({ path, args }) => this.call({ path, args }));
  }

  async call(input: { args: unknown[]; path: string[] }) {
    const { method, receiver } = resolveSdkMethod(this.#client, input.path);
    return await method.apply(receiver, input.args);
  }
}

async function slackAxiosAdapter(config: any) {
  const response = await fetch(new URL(config.url ?? "", config.baseURL).toString(), {
    body: requestBody(config.data),
    headers: requestHeaders(config.headers),
    method: config.method?.toUpperCase() ?? "POST",
  });
  const text = await response.text();
  return {
    config,
    data: text ? JSON.parse(text) : null,
    headers: Object.fromEntries(response.headers),
    request: {},
    status: response.status,
    statusText: response.statusText,
  };
}

function resolveSdkMethod(root: unknown, path: string[]) {
  if (path.length === 0) throw new Error("Slack SDK path is empty.");
  let receiver = root as Record<string, any>;
  for (const segment of path.slice(0, -1)) {
    receiver = receiver[segment];
    if (receiver == null) throw new Error(`Slack SDK path ${path.join(".")} is not available.`);
  }
  const method = receiver[path.at(-1)!];
  if (typeof method !== "function") {
    throw new Error(`Slack SDK path ${path.join(".")} did not resolve to a method.`);
  }
  return { method, receiver };
}

function requestHeaders(input: any) {
  const headers = new Headers();
  const source = typeof input?.toJSON === "function" ? input.toJSON() : (input ?? {});
  for (const [key, value] of Object.entries(source)) {
    if (value == null || value === false) continue;
    headers.set(key, String(value));
  }
  return headers;
}

function requestBody(input: unknown): BodyInit | undefined {
  if (input == null) return undefined;
  if (
    typeof input === "string" ||
    input instanceof URLSearchParams ||
    input instanceof FormData ||
    input instanceof Blob ||
    input instanceof ArrayBuffer
  ) {
    return input;
  }
  return JSON.stringify(input);
}

function slackConfigWorkerSource(input: { connectionKey: string; projectId: string }) {
  return dedent`
    import { WorkerEntrypoint } from "cloudflare:workers";
    import { liftLocalProxies } from "./local-proxy-wrapper.js";

    export default class SlackProofWorker extends WorkerEntrypoint {
      getIterateContextProps() {
        return {
          mounts: [
            {
              path: ["slack"],
              target: {
                type: "ctx",
                call: [
                  "projects",
                  { method: "get", args: [${JSON.stringify(input.projectId)}] },
                  "connections",
                  { method: "get", args: [${JSON.stringify(input.connectionKey)}] },
                  { method: "sdk" },
                ],
              },
            },
          ],
        };
      }

      async postDailyReport(input) {
        const ctx = await this.env.ITERATE.context;
        // ctx.slack is a mounted localProxyCaller marker. The config worker
        // lifts that marker into the SDK-shaped path proxy, so this tool can
        // call the natural Slack SDK shape without knowing the Slack hierarchy.
        using slack = liftLocalProxies(await ctx.slack);
        return await slack.chat.postMessage({
          channel: input.channel,
          text: input.text,
        });
      }

      async fetch() {
        return Response.json({ ok: true });
      }
    }
  `;
}

async function updateIterateConfigWorker(input: {
  ctx: RpcStub<IterateContext>;
  dir: string;
  projectId: string;
  workerSource: string;
}) {
  using projects = await input.ctx.projects;
  using project = await projects.get(input.projectId);
  using repos = await project.repos;
  using workspaces = await project.workspaces;
  using workspace = await workspaces.get("capnweb");
  using git = await workspace.git;
  const repo = await repos.ensureIterateConfigInfo({ projectSlug: null });

  await git.clone({
    branch: repo.defaultBranch,
    depth: 1,
    dir: input.dir,
    url: repo.remote,
    ...repo.credentials,
  });
  await workspace.writeFile(input.dir + "/worker.js", input.workerSource);
  await git.add({ dir: input.dir, filepath: "worker.js" });
  await git.commit({
    author: { name: "Capnweb", email: "captnweb-slack-e2e@iterate.com" },
    dir: input.dir,
    message: "Add Slack SDK Capnweb proof worker",
  });
  await git.push({
    dir: input.dir,
    ref: repo.defaultBranch,
    remote: "origin",
    ...repo.credentials,
  });
}

async function runCodemodeWithProjectEgressFetch<T>(
  ctx: RpcStub<IterateContext>,
  projectId: string,
  run: () => T | Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => projectEgressFetch(ctx, projectId, ...args);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function projectEgressFetch(
  ctx: RpcStub<IterateContext>,
  projectId: string,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  using projects = await ctx.projects;
  using project = await projects.get(projectId);
  return (await project.egressFetch(new Request(input, init))) as Response;
}

function withRootIterateContextFromNode(input: {
  auth: RootAccessAuth;
  baseUrl: string;
}): RpcStub<IterateContext> {
  const wsUrl = new URL(ROOT_ITERATE_CONTEXT_PREFIX, input.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl.toString(), { headers: rootAccessAuthHeaders(input.auth) });
  return liftLocalProxies(
    newWebSocketRpcSession<IterateContext>(
      socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
    ),
  );
}

function withIterateFromNode(input: { auth: RootAccessAuth; ingressUrl: string }): {
  ctx: RpcStub<IterateContext>;
  [Symbol.dispose](): void;
} {
  const { headers, wsUrl } = projectCapnwebWebSocketRequest({
    auth: input.auth,
    ingressUrl: input.ingressUrl,
    path: PROJECT_CAPNWEB_PATH,
  });
  const socket = new WebSocket(wsUrl.toString(), { headers });
  const project = newWebSocketRpcSession<ProjectCapability>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  const ctxHandle = project.getIterateContext() as unknown as RpcStub<IterateContext>;
  const ctx = liftLocalProxies(ctxHandle);
  return {
    ctx,
    [Symbol.dispose]() {
      ctxHandle[Symbol.dispose]?.();
      project[Symbol.dispose]?.();
      socket.close();
    },
  };
}

function projectCapnwebWebSocketRequest(input: {
  auth: RootAccessAuth;
  ingressUrl: string;
  path: string;
}) {
  const base = new URL(baseUrl);
  const ingress = new URL(input.ingressUrl);
  const wsUrl = new URL(
    input.path,
    base.hostname === "localhost" || base.hostname === "127.0.0.1" ? base : ingress,
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    headers: {
      ...rootAccessAuthHeaders(input.auth),
      ...(wsUrl.host === base.host
        ? {
            Host: ingress.hostname,
            "x-forwarded-host": ingress.hostname,
            "x-iterate-ingress-hostname": ingress.hostname,
          }
        : {}),
    },
    wsUrl,
  };
}

async function createDisposableProject(input: { root: RpcStub<IterateContext>; slug: string }) {
  using projects = await input.root.projects;
  const project = await projects.create({ slug: input.slug });
  return {
    ...project,
    async [Symbol.asyncDispose]() {
      await projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}

function rootAccessAuth() {
  return {
    token: new Redacted(requireRootAccessToken()),
  };
}

type RootAccessAuth = ReturnType<typeof rootAccessAuth>;

function rootAccessAuthHeaders(auth: RootAccessAuth) {
  return { Authorization: `Bearer ${auth.token.exposeSecret()}` };
}

type FakeSlackRequest = {
  body: string;
  headers: Record<string, string>;
  method: string;
  url: string;
};
