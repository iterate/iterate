import { afterAll, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import dedent from "dedent";
import WebSocket from "ws";
import { Redacted } from "@iterate-com/shared/apps/config";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "../../src/domains/secrets/example-secret.ts";
import {
  requireAdminBearerToken,
  requireBaseUrl,
  uniqueSuffix,
} from "../test-support/os-client.ts";
import type {
  IterateContext,
  IterateContextProps,
} from "../../src/capnweb/iterate-context-capability.ts";

const baseUrl = requireBaseUrl();
const auth = adminAuth();
const ADMIN_CAPNWEB_PREFIX = "/api/captnweb/admin";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

describe("capnweb", () => {
  const testRunSlugPrefix = `captnweb-${crypto.randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    const remaining = await listProjectsWithSlugPrefix(testRunSlugPrefix);
    expect(remaining).toEqual([]);
  });

  it("creates, lists, gets, and removes projects through admin capnweb", async () => {
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      admin,
      slug: `${testRunSlugPrefix}-crud-${uniqueSuffix()}`.slice(0, 40),
    });
    expect(project).toMatchObject({ id: expect.stringMatching(/^proj_/) });
    const projects = await admin.projects;
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
        ctx: admin,
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
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      admin,
      slug: `${testRunSlugPrefix}-stream-${uniqueSuffix()}`.slice(0, 40),
    });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    const streamPath = `/capnweb/project-session/${uniqueSuffix()}`;
    const eventType = "events.iterate.com/capnweb/project-session";
    const marker = `project-session-${uniqueSuffix()}`;
    const streams = await iterate.ctx.streams;
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

  it("updates iterate-config and calls env.ITERATE.context from dynamic worker fetch", async () => {
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      admin,
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
          const streams = await ctx.streams;
          const beforeStreams = await streams.list();
          const appended = await streams.append({
            streamPath,
            event: {
              type: eventType,
              payload: { marker, source: "iterate-config" },
            },
          });
          const afterStreams = await streams.list();
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
    const streams = await iterate.ctx.streams;
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
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      admin,
      slug: `${testRunSlugPrefix}-project-fetch-${uniqueSuffix()}`.slice(0, 40),
    });

    const result = await runCapnwebFunctionInDynamicWorker({
      fn: fetchProjectIngressAndEgress,
      props: { scopes: { projects: [project.id] } },
      vars: {
        echoUrl: "https://httpbin.org/anything",
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

  it("applies IterateContext mount props for target, method, catchall, and system shortcuts", async () => {
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      admin,
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
          const streams = await ctx.streams;
          const streamList = await streams.list();
          return {
            kind: "target-method",
            input,
            streamCountVisibleFromMountedWorker: streamList.length,
          };
        }
      }
    `;
    const catchallScript = dedent`
      import { WorkerEntrypoint } from "cloudflare:workers";

      export default class SdkLikeTarget extends WorkerEntrypoint {
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
            invoke: "catchall",
            path: ["sdk"],
            target: {
              call: ["call"],
              script: catchallScript,
              type: "dynamic-worker",
            },
          },
          {
            invoke: "catchall",
            path: ["some", "path", "sdk"],
            target: {
              call: ["call"],
              script: catchallScript,
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
      catchallResult: unknown;
      nestedCatchallResult: unknown;
      listedByMethod: string[];
      listedByShortcut: string[];
      methodResult: unknown;
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
    expect(result.catchallResult).toEqual({
      args: [{ text: marker }],
      method: "chat.postMessage",
    });
    expect(result.nestedCatchallResult).toEqual({
      args: [{ text: marker, via: "nested" }],
      method: "chat.postMessage",
    });
    expect(result.appendResult).toMatchObject({
      payload: { marker, source: "ctx-method-mount" },
      type: `${eventType}/method`,
    });
    expect(result.listedByShortcut).toEqual(
      expect.arrayContaining([`${project.id}:${streamPath}`]),
    );
    expect(result.listedByMethod).toEqual(expect.arrayContaining([`${project.id}:${streamPath}`]));
  });
});

function withAdminIterateFromNode(input: {
  auth: AdminAuth;
  baseUrl: string;
}): RpcStub<IterateContext> {
  const wsUrl = new URL(ADMIN_CAPNWEB_PREFIX, input.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl.toString(), { headers: adminAuthHeaders(input.auth) });
  return newWebSocketRpcSession<IterateContext>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

function withIterateFromNode(input: { auth: AdminAuth; ingressUrl: string }): {
  ctx: RpcStub<IterateContext>;
  onWsFrame: (frame: unknown) => void;
  [Symbol.dispose](): void;
} {
  const base = new URL(baseUrl);
  const ingress = new URL(input.ingressUrl);
  const wsUrl = new URL(
    PROJECT_CAPNWEB_PATH,
    base.hostname === "localhost" || base.hostname === "127.0.0.1" ? base : ingress,
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl.toString(), {
    headers: {
      ...adminAuthHeaders(input.auth),
      ...(wsUrl.host === base.host
        ? {
            Host: ingress.hostname,
            "x-forwarded-host": ingress.hostname,
            "x-iterate-ingress-hostname": ingress.hostname,
          }
        : {}),
    },
  });
  const ctx = newWebSocketRpcSession<IterateContext>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
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

type MountedIterateContext = RpcStub<IterateContext> & Record<string, any>;

type CapnwebFunctionInput<Vars extends Record<string, unknown>> = {
  ctx: MountedIterateContext;
  env: Record<string, unknown>;
  vars: Vars;
};

type ProjectConfigWorkerTestApi = {
  someFunction(input: { echo: string }): Promise<unknown>;
};

type CapnwebFunction<Vars extends Record<string, unknown>, Result> = (
  input: CapnwebFunctionInput<Vars>,
) => Result | Promise<Result>;

async function describeProjectThroughProjects({
  ctx,
  vars,
}: CapnwebFunctionInput<{ projectId: string }>) {
  const projects = await ctx.projects;
  const project = await projects.get(vars.projectId);
  try {
    return await project.describe();
  } finally {
    project[Symbol.dispose]?.();
  }
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
  const projects = await ctx.projects;
  const disposables = [];
  try {
    const project = await projects.get(vars.projectId);
    disposables.push(project);
    const repos = await project.repos;
    disposables.push(repos);
    const workspace = await project.workspace;
    disposables.push(workspace);
    const git = await workspace.git;
    disposables.push(git);
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

    const worker = await project.worker;
    disposables.push(worker);
    const calledTool = await (worker as unknown as ProjectConfigWorkerTestApi).someFunction({
      echo: vars.marker,
    });

    return {
      calledTool,
      project: await project.describe(),
      repoSlug: repo.slug,
    };
  } finally {
    for (const disposable of disposables.reverse()) {
      disposable[Symbol.dispose]?.();
    }
  }
}

async function fetchProjectIngressAndEgress({
  ctx,
  vars,
}: CapnwebFunctionInput<{
  echoUrl: string;
  ingressUrl: string;
  secretKey: string;
}>) {
  const project = await ctx.project;
  try {
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
  } finally {
    project[Symbol.dispose]?.();
  }
}

async function exerciseMountedContext({
  ctx,
  vars,
}: CapnwebFunctionInput<{
  eventType: string;
  marker: string;
  streamPath: string;
}>) {
  const disposables = [];
  try {
    const tools = await ctx.tools;
    disposables.push(tools);
    const targetResult = await tools.echo({ marker: vars.marker });
    const nestedResult = await tools.nested.describe({ marker: vars.marker });

    const methodResult = await ctx.rootEcho({ marker: vars.marker });

    const mountedStreams = await ctx.mountedStreams;
    disposables.push(mountedStreams);
    await mountedStreams.append({
      streamPath: vars.streamPath,
      event: {
        type: vars.eventType,
        payload: { marker: vars.marker, source: "mount-shortcut" },
      },
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

    const sdk = await ctx.sdk;
    disposables.push(sdk);
    const catchallResult = await sdk.chat.postMessage({ text: vars.marker });
    const nestedSdk = await ctx.some.path.sdk;
    disposables.push(nestedSdk);
    const nestedCatchallResult = await nestedSdk.chat.postMessage({
      text: vars.marker,
      via: "nested",
    });

    return {
      appendResult,
      catchallResult,
      nestedCatchallResult,
      listedByMethod: listedByMethod.map((stream: { name: string }) => stream.name),
      listedByShortcut: listedByShortcut.map((stream: { name: string }) => stream.name),
      methodResult,
      nestedResult,
      targetResult,
    };
  } finally {
    for (const disposable of disposables.reverse()) {
      disposable[Symbol.dispose]?.();
    }
  }
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
  const url = new URL(`${ADMIN_CAPNWEB_PREFIX}/run`, baseUrl);
  const response = await fetch(url, {
    body: JSON.stringify({
      functionSource: input.fn.toString(),
      props: input.props,
      vars: input.vars,
    }),
    headers: {
      ...adminAuthHeaders(auth),
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

function adminAuth() {
  return {
    type: "admin" as const,
    token: new Redacted(requireAdminBearerToken()),
  };
}

type AdminAuth = ReturnType<typeof adminAuth>;

function adminAuthHeaders(auth: AdminAuth) {
  return { Authorization: `Bearer ${auth.token.exposeSecret()}` };
}

async function createDisposableProject(input: { admin: RpcStub<IterateContext>; slug: string }) {
  const projects = await input.admin.projects;
  const project = await projects.create({ slug: input.slug });
  return {
    ...project,
    async [Symbol.asyncDispose]() {
      await projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}

async function listProjectsWithSlugPrefix(prefix: string) {
  const matches: Array<{ id: string; slug: string }> = [];
  const limit = 100;
  using admin = withAdminIterateFromNode({ auth, baseUrl });
  const projects = await admin.projects;
  for (let offset = 0; ; offset += limit) {
    const page = await projects.list({ limit, offset });
    matches.push(...page.projects.filter((project) => project.slug.startsWith(prefix)));
    if (offset + page.projects.length >= page.total || page.projects.length === 0) return matches;
  }
}
