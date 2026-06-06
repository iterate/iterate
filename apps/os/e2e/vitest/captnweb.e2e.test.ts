import { afterAll, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import dedent from "dedent";
import WebSocket from "ws";
import { Redacted } from "@iterate-com/shared/apps/config";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "../../src/domains/secrets/example-secret.ts";
import { requireRootAccessToken, requireBaseUrl, uniqueSuffix } from "../test-support/os-client.ts";
import type {
  IterateContext,
  IterateContextProps,
} from "../../src/capnweb/iterate-context-capability.ts";
import { liftLocalProxies } from "../../src/capnweb/local-proxy-wrapper.js";

const baseUrl = requireBaseUrl();
const egressEchoBaseUrl = requireEgressEchoBaseUrl(baseUrl);
const auth = rootAccessAuth();
const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";
const PROJECT_CAPNWEB_CONNECTIONS_PATH = "/__iterate/capnweb/connections";

describe("capnweb", () => {
  const testRunSlugPrefix = `captnweb-${crypto.randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    const remaining = await listProjectsWithSlugPrefix(testRunSlugPrefix);
    expect(remaining).toEqual([]);
  });

  it("creates, lists, gets, and removes projects through root Iterate context", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-crud-${uniqueSuffix()}`.slice(0, 40),
    });
    expect(project).toMatchObject({ id: expect.stringMatching(/^proj_/) });
    using projects = await root.projects;
    const list = await projects.list({ limit: 1_000 });
    expect(list.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id, slug: project.slug })]),
    );
    {
      using projectContext = await projects.get(project.id);
      expect(await projectContext.describe()).toMatchObject({
        id: project.id,
        slug: project.slug,
      });
    }
    expect(
      await runCapnwebFunctionFromNode({
        ctx: root,
        fn: describeProjectThroughProjects,
        vars: { projectId: project.id },
      }),
    ).toMatchObject({
      id: project.id,
      slug: project.slug,
    });
    expect(
      await runCapnwebFunctionInDynamicWorker({
        fn: describeProjectThroughProjects,
        vars: { projectId: project.id },
      }),
    ).toMatchObject({
      id: project.id,
      slug: project.slug,
    });
    expect(await projects.remove({ id: project.id })).toEqual({
      deleted: true,
      id: project.id,
      ok: true,
    });
  });

  it("connects directly to the project durable object capnweb session", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-stream-${uniqueSuffix()}`.slice(0, 40),
    });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    const streamPath = `/capnweb/project-session/${uniqueSuffix()}`;
    const eventType = "events.iterate.com/capnweb/project-session";
    const marker = `project-session-${uniqueSuffix()}`;
    using streams = await iterate.ctx.streams;
    const appended = await streams.append({
      event: { type: eventType, payload: { marker } },
      streamPath,
    });
    const events = await streams.read({ afterOffset: "start", streamPath });
    expect(appended).toMatchObject({ payload: { marker }, type: eventType });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ payload: { marker }, type: eventType })]),
    );
  });

  it("calls a project Cap'n Web connection from node and dynamic worker code", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-connection-${uniqueSuffix()}`.slice(0, 40),
    });
    const connectionKey = `connection-${uniqueSuffix()}`;
    await using connection = await withProjectConnectionFromNode({
      auth,
      connectionKey,
      ingressUrl: project.ingressUrl,
      target: new ProjectConnectionTestTarget({ marker: connectionKey }),
    });

    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    const fromNode = await runCapnwebFunctionFromNode({
      ctx: iterate.ctx,
      fn: callProjectConnection,
      vars: { connectionKey, source: "node" },
    });
    const fromDynamicWorker = await runCapnwebFunctionInDynamicWorker({
      fn: callProjectConnection,
      props: { scopes: { projects: [project.id] } },
      vars: { connectionKey, source: "dynamic-worker" },
    });

    expect(fromNode).toEqual({
      callCount: 1,
      marker: connectionKey,
      source: "node",
    });
    expect(fromDynamicWorker).toEqual({
      callCount: 2,
      marker: connectionKey,
      source: "dynamic-worker",
    });
  });

  it("updates iterate-config and calls env.ITERATE.context from dynamic worker fetch", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-worker-${uniqueSuffix()}`.slice(0, 40),
    });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    const marker = `capnweb-worker-${uniqueSuffix()}`;
    const streamPath = `/capnweb/worker/${marker}`;
    const eventType = `events.iterate.com/capnweb/worker/${marker}`;
    const workerSource = dedent`
      export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          const ctx = await env.ITERATE.context;
          const streamPath = url.searchParams.get("streamPath");
          const eventType = url.searchParams.get("eventType");
          const marker = url.searchParams.get("marker");
          using streams = await ctx.streams;
          const beforeStreams = await streams.list();
          const listUntilStreamAppears = async () => {
            for (let attempt = 0; attempt < 8; attempt++) {
              const listedStreams = await streams.list();
              if (listedStreams.some((stream) => stream.streamPath === streamPath)) {
                return listedStreams;
              }
              // Deployed stream listing can lag a successful append/read by a short interval.
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            return streams.list();
          };
          const appended = await streams.append({
            streamPath,
            event: {
              type: eventType,
              payload: { marker, source: "iterate-config" },
            },
          });
          const afterStreams = await listUntilStreamAppears();
          const events = await streams.read({ afterOffset: "start", streamPath });
          return Response.json({
            appended: {
              eventType: appended.type,
              marker: appended.payload.marker,
              offset: appended.offset,
              streamPath,
            },
            streamNames: afterStreams.map((stream) => stream.name),
            streamWasListedBeforeAppend: beforeStreams.some((stream) => stream.streamPath === streamPath),
            streamWasListedAfterAppend: afterStreams.some((stream) => stream.streamPath === streamPath),
            events,
          });
        },
        async someFunction(input = {}) {
          return { from: "iterate-config", input, marker: ${JSON.stringify(marker)} };
        },
      };
    `;

    const dir = `/iterate-config-${Date.now()}`;
    const updateResult = await runCapnwebFunctionInDynamicWorker({
      fn: updateIterateConfigWorker,
      vars: {
        dir,
        marker,
        projectId: project.id,
        workerSource,
      },
    });
    expect(updateResult).toMatchObject({
      calledTool: { from: "iterate-config", input: { echo: marker }, marker },
      project: { id: project.id, slug: project.slug },
      repoSlug: "iterate-config",
    });

    using projectContext = await iterate.ctx.project;
    using worker = await projectContext.worker;
    const streamFetchResponse = await worker.fetch(
      new Request(
        `https://iterate-config.local/capnweb-fetch/${marker}?${new URLSearchParams({
          eventType,
          marker,
          streamPath,
        })}`,
      ),
    );
    expect(streamFetchResponse.ok).toBe(true);
    const streamFetch = (await streamFetchResponse.json()) as {
      appended: unknown;
      events: unknown[];
      streamNames: string[];
      streamWasListedAfterAppend: boolean;
      streamWasListedBeforeAppend: boolean;
    };
    const called = await (worker as unknown as ProjectConfigWorkerTestApi).someFunction({
      echo: marker,
    });
    using streams = await iterate.ctx.streams;
    const streamEvents = await streams.read({ afterOffset: "start", streamPath });

    expect(called).toEqual({ from: "iterate-config", input: { echo: marker }, marker });
    expect(streamFetch.appended).toMatchObject({
      eventType,
      marker,
      offset: expect.any(Number),
      streamPath,
    });
    expect(streamFetch.streamWasListedBeforeAppend).toBe(false);
    expect(streamFetch.streamWasListedAfterAppend).toBe(true);
    expect(streamFetch.streamNames).toEqual(
      expect.arrayContaining([`${project.id}:${streamPath}`]),
    );
    expect(streamFetch.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { marker, source: "iterate-config" },
          type: eventType,
        }),
      ]),
    );
    expect(streamEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { marker, source: "iterate-config" },
          type: eventType,
        }),
      ]),
    );
  });

  it("uses codemode ctx.project.fetch and ctx.project.egressFetch from worker.js", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-project-fetch-${uniqueSuffix()}`.slice(0, 40),
    });

    const result = await runCapnwebFunctionInDynamicWorker({
      fn: fetchProjectIngressAndEgress,
      props: { scopes: { projects: [project.id] } },
      vars: {
        echoAuthToken: auth.token.exposeSecret(),
        echoUrl: new URL("/api/captnweb/egress-echo", egressEchoBaseUrl).toString(),
        ingressUrl: project.ingressUrl,
        secretKey: EXAMPLE_EGRESS_SECRET_KEY,
      },
    });

    expect(result.ingress).toEqual({
      status: 200,
      text: "Hello from the project config worker",
    });
    expect(result.egress).toMatchObject({
      secretReferenceWasSubstituted: true,
      status: 200,
    });
    expect(result.egress.echoedSecretHeader).toBe(`Bearer ${EXAMPLE_EGRESS_SECRET_MATERIAL}`);
  });

  it("applies IterateContext mount props for target, method, sdk markers, and ctx shortcuts", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-mounts-${uniqueSuffix()}`.slice(0, 40),
    });
    const marker = `mounts-${uniqueSuffix()}`;
    const streamPath = `/capnweb/mounts/${marker}`;
    const eventType = `events.iterate.com/capnweb/mounts/${marker}`;
    const toolsScript = dedent`
      import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

      class NestedTools extends RpcTarget {
        async describe(input) {
          return { kind: "nested-target", input };
        }
      }

      export default class Tools extends WorkerEntrypoint {
        get nested() {
          return new NestedTools();
        }

        async echo(input) {
          const ctx = await this.env.ITERATE.context;
          using streams = await ctx.streams;
          const streamList = await streams.list();
          return {
            kind: "target-method",
            input,
            streamCountVisibleFromMountedWorker: streamList.length,
          };
        }
      }
    `;
    const sdkScript = dedent`
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { localProxyCaller } from "./local-proxy-wrapper.js";

      export default class SdkLikeTarget extends WorkerEntrypoint {
        get sdk() {
          return localProxyCaller(({ path, args }) => this.call({ path, args }));
        }

        async call({ path, args }) {
          return {
            args,
            method: path.join("."),
          };
        }
      }
    `;

    const result = (await runCapnwebFunctionInDynamicWorker({
      fn: exerciseMountedContext,
      props: {
        scopes: { projects: [project.id] },
        mounts: [
          {
            path: ["tools"],
            target: {
              script: toolsScript,
              type: "dynamic-worker",
            },
          },
          {
            invoke: "method",
            path: ["rootEcho"],
            target: {
              call: ["echo"],
              script: toolsScript,
              type: "dynamic-worker",
            },
          },
          {
            path: ["sdk"],
            target: {
              call: ["sdk"],
              script: sdkScript,
              type: "dynamic-worker",
            },
          },
          {
            path: ["some", "path", "sdk"],
            target: {
              call: ["sdk"],
              script: sdkScript,
              type: "dynamic-worker",
            },
          },
          {
            path: ["mountedStreams"],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams"],
              type: "ctx",
            },
          },
          {
            invoke: "method",
            path: ["listStreams"],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams", "list"],
              type: "ctx",
            },
          },
          {
            invoke: "method",
            path: ["append"],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams", "append"],
              type: "ctx",
            },
          },
        ],
      },
      vars: {
        eventType,
        marker,
        streamPath,
      },
    })) as {
      appendResult: unknown;
      sdkResult: unknown;
      eventsByShortcut: unknown[];
      eventsByMethod: unknown[];
      nestedSdkResult: unknown;
      listedByMethod: string[];
      listedByShortcut: string[];
      methodResult: unknown;
      mountedAppendResult: unknown;
      nestedResult: unknown;
      targetResult: unknown;
    };

    expect(result.targetResult).toMatchObject({
      input: { marker },
      kind: "target-method",
      streamCountVisibleFromMountedWorker: expect.any(Number),
    });
    expect(result.nestedResult).toEqual({
      input: { marker },
      kind: "nested-target",
    });
    expect(result.methodResult).toMatchObject({
      input: { marker },
      kind: "target-method",
    });
    expect(result.mountedAppendResult).toMatchObject({
      payload: { marker, source: "mount-shortcut" },
      type: eventType,
    });
    expect(result.eventsByShortcut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { marker, source: "mount-shortcut" },
          type: eventType,
        }),
      ]),
    );
    expect(result.sdkResult).toEqual({
      args: [{ text: marker }],
      method: "chat.postMessage",
    });
    expect(result.nestedSdkResult).toEqual({
      args: [{ text: marker, via: "nested" }],
      method: "chat.postMessage",
    });
    expect(result.appendResult).toMatchObject({
      payload: { marker, source: "ctx-method-mount" },
      type: `${eventType}/method`,
    });
    expect(result.eventsByMethod).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { marker, source: "ctx-method-mount" },
          type: `${eventType}/method`,
        }),
      ]),
    );
    expect(result.listedByShortcut).toEqual(expect.any(Array));
    expect(result.listedByMethod).toEqual(expect.any(Array));
  });
});

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
  onWsFrame: (frame: unknown) => void;
  [Symbol.dispose](): void;
} {
  const { headers, wsUrl } = projectCapnwebWebSocketRequest({
    auth: input.auth,
    ingressUrl: input.ingressUrl,
    path: PROJECT_CAPNWEB_PATH,
  });
  const socket = new WebSocket(wsUrl.toString(), { headers });
  const ctx = liftLocalProxies(
    newWebSocketRpcSession<IterateContext>(
      socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
    ),
  );
  return {
    ctx,
    onWsFrame(_frame: unknown) {},
    [Symbol.dispose]() {
      ctx[Symbol.dispose]?.();
      socket.close();
    },
  };
}

async function withProjectConnectionFromNode(input: {
  auth: RootAccessAuth;
  connectionKey: string;
  ingressUrl: string;
  target: RpcTarget;
}): Promise<Disposable> {
  const { headers, wsUrl } = projectCapnwebWebSocketRequest({
    auth: input.auth,
    ingressUrl: input.ingressUrl,
    path: PROJECT_CAPNWEB_CONNECTIONS_PATH,
  });
  wsUrl.searchParams.set("key", input.connectionKey);
  const socket = new WebSocket(wsUrl.toString(), { headers });
  const session = newWebSocketRpcSession(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
    input.target,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    [Symbol.dispose]() {
      session[Symbol.dispose]?.();
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

// The shared capnweb functions below are deliberately JavaScript-shaped: the
// same source is executed from Node and stringified into a dynamic worker. Cap'n
// Web stubs expose wildcard members at runtime, so this test harness keeps the
// context dynamic instead of making every example fight proxy placeholder types.
type MountedIterateContext = any;

type CapnwebFunctionInput<Vars extends Record<string, unknown>> = {
  ctx: MountedIterateContext;
  env: Record<string, unknown>;
  vars: Vars;
};

type ProjectConfigWorkerTestApi = {
  someFunction(input: { echo: string }): Promise<unknown>;
};

class ProjectConnectionTestTarget extends RpcTarget {
  #callCount = 0;
  readonly #marker: string;

  constructor(input: { marker: string }) {
    super();
    this.#marker = input.marker;
  }

  someMethod(input: { source: string }) {
    this.#callCount += 1;
    return {
      callCount: this.#callCount,
      marker: this.#marker,
      source: input.source,
    };
  }
}

type CapnwebFunction<Vars extends Record<string, unknown>, Result> = (
  input: CapnwebFunctionInput<Vars>,
) => Result | Promise<Result>;

async function describeProjectThroughProjects({
  ctx,
  vars,
}: CapnwebFunctionInput<{ projectId: string }>) {
  using projects = await ctx.projects;
  using project = await projects.get(vars.projectId);
  return await project.describe();
}

async function updateIterateConfigWorker({
  ctx,
  vars,
}: CapnwebFunctionInput<{
  dir: string;
  marker: string;
  projectId: string;
  workerSource: string;
}>) {
  using projects = await ctx.projects;
  using project = await projects.get(vars.projectId);
  using repos = await project.repos;
  using workspace = await project.workspace;
  using git = await workspace.git;
  const repo = await repos.ensureIterateConfigInfo({ projectSlug: null });

  await git.clone({
    branch: repo.defaultBranch,
    depth: 1,
    dir: vars.dir,
    url: repo.remote,
    ...repo.credentials,
  });
  await workspace.writeFile(vars.dir + "/worker.js", vars.workerSource);
  await git.add({ dir: vars.dir, filepath: "worker.js" });
  await git.commit({
    author: { name: "Capnweb", email: "captnweb-e2e@iterate.com" },
    dir: vars.dir,
    message: "Add capnweb worker proof from /run",
  });
  await git.push({
    dir: vars.dir,
    ref: repo.defaultBranch,
    remote: "origin",
    ...repo.credentials,
  });

  using worker = await project.worker;
  const calledTool = await (worker as unknown as ProjectConfigWorkerTestApi).someFunction({
    echo: vars.marker,
  });

  return {
    calledTool,
    project: await project.describe(),
    repoSlug: repo.slug,
  };
}

async function fetchProjectIngressAndEgress({
  ctx,
  vars,
}: CapnwebFunctionInput<{
  echoAuthToken: string;
  echoUrl: string;
  ingressUrl: string;
  secretKey: string;
}>) {
  using project = await ctx.project;
  const expectedHomepageText = "Hello from the project config worker";
  let ingress = { status: 0, text: "" };
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await project.fetch(new Request(vars.ingressUrl + "/"));
    ingress = {
      status: response.status,
      text: await response.text(),
    };
    if (ingress.status === 200 && ingress.text === expectedHomepageText) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (ingress.status !== 200 || ingress.text !== expectedHomepageText) {
    throw new Error(
      `Expected project fetch to return default homepage, got ${ingress.status}: ${ingress.text}`,
    );
  }

  const headerName = "x-iterate-example-secret";
  const secretReference = `Bearer getSecret({ key: ${JSON.stringify(vars.secretKey)} })`;
  const egressResponse = await project.egressFetch(
    new Request(vars.echoUrl, {
      headers: {
        authorization: `Bearer ${vars.echoAuthToken}`,
        [headerName]: secretReference,
      },
    }),
  );
  const body = (await egressResponse.json()) as {
    headers?: Record<string, string | string[] | undefined>;
    url?: string;
  };
  const echoedHeader = body.headers?.[headerName] ?? body.headers?.["X-Iterate-Example-Secret"];
  const echoedSecretHeader = Array.isArray(echoedHeader)
    ? echoedHeader.join(", ")
    : String(echoedHeader ?? "");

  return {
    egress: {
      echoedSecretHeader,
      echoUrl: body.url,
      secretReferenceWasSubstituted: echoedSecretHeader !== secretReference,
      status: egressResponse.status,
    },
    ingress,
  };
}

async function callProjectConnection({
  ctx,
  vars,
}: CapnwebFunctionInput<{ connectionKey: string; source: string }>) {
  using project = await ctx.project;
  using connections = await project.connections;
  using connection = await connections.get(vars.connectionKey);
  return await connection.someMethod({ source: vars.source });
}

async function exerciseMountedContext({
  ctx,
  vars,
}: CapnwebFunctionInput<{
  eventType: string;
  marker: string;
  streamPath: string;
}>) {
  using tools = await ctx.tools;
  const targetResult = await tools.echo({ marker: vars.marker });
  const nestedResult = await tools.nested.describe({ marker: vars.marker });

  const methodResult = await ctx.rootEcho({ marker: vars.marker });

  using mountedStreams = await ctx.mountedStreams;
  const mountedAppendResult = await mountedStreams.append({
    streamPath: vars.streamPath,
    event: {
      type: vars.eventType,
      payload: { marker: vars.marker, source: "mount-shortcut" },
    },
  });
  const eventsByShortcut = await mountedStreams.read({
    afterOffset: "start",
    streamPath: vars.streamPath,
  });

  const listedByShortcut = await mountedStreams.list();
  const listedByMethod = await ctx.listStreams();
  const appendResult = await ctx.append({
    streamPath: vars.streamPath,
    event: {
      type: `${vars.eventType}/method`,
      payload: { marker: vars.marker, source: "ctx-method-mount" },
    },
  });
  const eventsByMethod = await mountedStreams.read({
    afterOffset: "start",
    streamPath: vars.streamPath,
  });

  using sdk = await ctx.sdk;
  const sdkResult = await sdk.chat.postMessage({ text: vars.marker });
  using nestedSdk = await ctx.some.path.sdk;
  const nestedSdkResult = await nestedSdk.chat.postMessage({
    text: vars.marker,
    via: "nested",
  });

  return {
    appendResult,
    eventsByMethod,
    eventsByShortcut,
    nestedSdkResult,
    listedByMethod: listedByMethod.map((stream: { name: string }) => stream.name),
    listedByShortcut: listedByShortcut.map((stream: { name: string }) => stream.name),
    methodResult,
    mountedAppendResult,
    nestedResult,
    sdkResult,
    targetResult,
  };
}

async function runCapnwebFunctionFromNode<Vars extends Record<string, unknown>, Result>(input: {
  ctx: RpcStub<IterateContext>;
  fn: CapnwebFunction<Vars, Result>;
  vars: Vars;
}): Promise<Awaited<Result>> {
  return await input.fn({ ctx: input.ctx as MountedIterateContext, env: {}, vars: input.vars });
}

async function runCapnwebFunctionInDynamicWorker<
  Vars extends Record<string, unknown>,
  Result,
>(input: {
  fn: CapnwebFunction<Vars, Result>;
  props?: IterateContextProps;
  vars: Vars;
}): Promise<Awaited<Result>> {
  const url = new URL(`${ROOT_ITERATE_CONTEXT_PREFIX}/run`, baseUrl);
  const response = await fetch(url, {
    body: JSON.stringify({
      functionSource: input.fn.toString(),
      props: input.props,
      vars: input.vars,
    }),
    headers: {
      ...rootAccessAuthHeaders(auth),
      "content-type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body as Awaited<Result>;
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

function requireEgressEchoBaseUrl(controlPlaneBaseUrl: string) {
  const explicit = process.env.OS_E2E_EGRESS_ECHO_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const url = new URL(controlPlaneBaseUrl);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return controlPlaneBaseUrl;
  }

  throw new Error(
    "OS_E2E_EGRESS_ECHO_BASE_URL is required when APP_CONFIG_BASE_URL points at localhost.",
  );
}

async function createDisposableProject(input: { root: RpcStub<IterateContext>; slug: string }) {
  const projects = await input.root.projects;
  const project = await projects.create({ slug: input.slug });
  return {
    ...project,
    async [Symbol.asyncDispose]() {
      try {
        await projects.remove({ id: project.id }).catch(() => undefined);
      } finally {
        projects[Symbol.dispose]?.();
      }
    },
  };
}

async function listProjectsWithSlugPrefix(prefix: string) {
  const matches: Array<{ id: string; slug: string }> = [];
  const limit = 100;
  using root = withRootIterateContextFromNode({ auth, baseUrl });
  using projects = await root.projects;
  for (let offset = 0; ; offset += limit) {
    const page = await projects.list({ limit, offset });
    matches.push(...page.projects.filter((project) => project.slug.startsWith(prefix)));
    if (offset + page.projects.length >= page.total || page.projects.length === 0) return matches;
  }
}
