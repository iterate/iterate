import type { RpcStub } from "capnweb";
import type { IterateContext } from "../iterate-context-capability.ts";

export type BuiltinCapnwebContext = RpcStub<IterateContext>;

export type CapnwebScriptInput<
  Vars extends Record<string, unknown> = Record<string, unknown>,
  Ctx = BuiltinCapnwebContext,
> = {
  ctx: Ctx;
  vars: Vars;
};

export type CapnwebScript<
  Vars extends Record<string, unknown> = Record<string, unknown>,
  Ctx = BuiltinCapnwebContext,
  Result = unknown,
> = (input: CapnwebScriptInput<Vars, Ctx>) => Result | Promise<Result>;

class CapnwebScriptBuilder<
  Ctx = BuiltinCapnwebContext,
  Vars extends Record<string, unknown> = Record<string, unknown>,
> {
  define<Result>(fn: CapnwebScript<Vars, Ctx, Result>) {
    return fn;
  }

  vars<NewVars extends Record<string, unknown>>() {
    return this as unknown as CapnwebScriptBuilder<Ctx, NewVars>;
  }

  /**
   * Type-only override for scripts that need more than the built-in Iterate
   * capability tree. This copies the existing codemode builder precedent:
   * `.context<T>()` changes TypeScript's view of `ctx`, but it does not change
   * runtime wiring. The default remains the normal built-in Iterate context.
   */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    type ReplacementCtx = Mode extends "extend" ? Ctx & NewCtx : NewCtx;
    return this as unknown as CapnwebScriptBuilder<ReplacementCtx, Vars>;
  }
}

export const capnwebScript = new CapnwebScriptBuilder();

/**
 * Builds the iterate-config `worker.js` used by the git-update scenario.
 *
 * This proves the dynamic worker that comes from a project's iterate-config repo
 * receives the same `env.ITERATE.context` capability shape as codemode `/run`.
 * In other words, after a script updates git, the project worker can call
 * `env.ITERATE.context.streams` without knowing whether the original caller was
 * Node, browser, CLI, or another dynamic worker.
 */
export function buildIterateConfigWorkerSource(input: { marker: string }) {
  return `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The iterate-config worker uses the same context binding as /run and
    // codemode scripts. No test-only ctx injection is involved.
    const ctx = await env.ITERATE.context;
    const streamPath = url.searchParams.get("streamPath");
    const eventType = url.searchParams.get("eventType");
    const marker = url.searchParams.get("marker");
    const executionMode = url.searchParams.get("executionMode");
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
        payload: { executionMode, marker, source: "iterate-config" },
      },
    });
    const afterStreams = await listUntilStreamAppears();
    const events = await streams.read({ afterOffset: "start", streamPath });
    return Response.json({
      appended: {
        eventType: appended.type,
        executionMode: appended.payload.executionMode,
        marker: appended.payload.marker,
        offset: appended.offset,
        streamPath,
      },
      streamNames: afterStreams.map((stream) => stream.name),
      streamWasListedBeforeAppend: beforeStreams.some(
        (stream) => stream.streamPath === streamPath,
      ),
      streamWasListedAfterAppend: afterStreams.some(
        (stream) => stream.streamPath === streamPath,
      ),
      events,
    });
  },
  async someFunction(input = {}) {
    return { from: "iterate-config", input, marker: ${JSON.stringify(input.marker)} };
  },
};
`.trim();
}

/**
 * Root-context script: starts at `ctx.projects`, gets a fully qualified project
 * capability, and returns its stable description.
 *
 * This proves a broad/root IterateContext and a project-scoped IterateContext
 * are the same capability tree at different scopes: root code can enter any
 * allowed project explicitly via `ctx.projects.get(id)`, while project-scoped
 * code may use the `ctx.project` shortcut for the same target.
 */
export const describeProjectThroughProjects = capnwebScript
  .vars<{ executionMode: string; projectId: string }>()
  .define(async ({ ctx, vars }) => {
    using projects = await ctx.projects;
    using project = await projects.get(vars.projectId);
    return { ...(await project.describe()), executionMode: vars.executionMode };
  });

/**
 * Project-context script: uses `ctx.streams` as the project-scoped streams
 * collection, appends an event, then reads the same stream back.
 *
 * This proves stream namespacing is supplied by the IterateContext capability,
 * not by handwritten runner code. The same function can run from all supported
 * runtimes and still resolve `/some/path` under the current project namespace.
 */
export const appendAndReadProjectStream = capnwebScript
  .vars<{
    eventType: string;
    executionMode: string;
    marker: string;
    streamPath: string;
  }>()
  .define(async ({ ctx, vars }) => {
    using streams = await ctx.streams;
    const appended = await streams.append({
      event: {
        type: vars.eventType,
        payload: { executionMode: vars.executionMode, marker: vars.marker },
      },
      streamPath: vars.streamPath,
    });
    const events = await streams.read({ afterOffset: "start", streamPath: vars.streamPath });
    return { appended, events, executionMode: vars.executionMode };
  });

/**
 * Project-context script: calls a test-runner-provided RpcTarget through
 * `ctx.project.connections`.
 *
 * This proves capabilities can flow in both directions. The project can hold a
 * parent-owned RpcTarget, and later codemode/dynamic-worker code can call back
 * into it through the canonical context tree instead of a bespoke test hook.
 */
export const callProjectConnection = capnwebScript
  .vars<{ connectionKey: string; methodName: string; source: string }>()
  .define(async ({ ctx, vars }) => {
    using project = await ctx.project;
    using connections = await project.connections;
    using connection = await connections.get(vars.connectionKey);
    // The built-in type proves `ctx.project.connections` exists. The method name
    // is intentionally provided by the test-owned RpcTarget at runtime.
    return await (connection as Record<string, any>)[vars.methodName]({ source: vars.source });
  });

/**
 * Project-context script: edits the iterate-config repo through
 * `ctx.project.workspace.git`, pushes a new `worker.js`, then immediately calls
 * the resulting `ctx.project.worker.someFunction(...)` tool.
 *
 * This is the highest-signal codemode proof. It shows the same script can run
 * from Node, browser, CLI, or `/run`; can mutate project configuration through
 * ordinary project capabilities; and can then use the newly deployed worker as a
 * first-class tool at `ctx.project.worker`.
 */
export const updateIterateConfigAndCallWorker = capnwebScript
  .vars<{
    dir: string;
    executionMode: string;
    marker: string;
    workerSource: string;
  }>()
  .define(async ({ ctx, vars }) => {
    using project = await ctx.project;
    using repos = await project.repos;
    using workspace = await project.workspace;
    // This is the intended project-scoped git path for codemode and tests:
    // the IterateContext shortcut resolves to ctx.projects.get(id).
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
      message: `Add capnweb worker proof from ${vars.executionMode}`,
    });
    await git.push({
      dir: vars.dir,
      ref: repo.defaultBranch,
      remote: "origin",
      ...repo.credentials,
    });

    using worker = (await project.worker) as any;
    const calledTool = await worker.someFunction({
      echo: vars.marker,
      executionMode: vars.executionMode,
    });

    return {
      calledTool,
      executionMode: vars.executionMode,
      project: await project.describe(),
      repoSlug: repo.slug,
      workspaceGitPath: "ctx.project.workspace.git",
    };
  });

/**
 * Project-context script: calls the iterate-config worker that the git-update
 * script wrote, both as a normal RPC tool and as a fetch handler.
 *
 * This proves the updated project worker is available at the canonical
 * `ctx.project.worker` path from every runtime. The worker's fetch handler then
 * calls `env.ITERATE.context.streams`, which closes the loop: caller-owned
 * codemode, project-owned config workers, and server-owned Durable Object
 * capabilities all use the same context model.
 */
export const callUpdatedIterateConfigWorker = capnwebScript
  .vars<{
    eventType: string;
    executionMode: string;
    marker: string;
    streamPath: string;
  }>()
  .define(async ({ ctx, vars }) => {
    using project = await ctx.project;
    using worker = (await project.worker) as any;
    const streamFetchResponse = await worker.fetch(
      new Request(
        `https://iterate-config.local/capnweb-fetch/${vars.marker}?${new URLSearchParams({
          eventType: vars.eventType,
          executionMode: vars.executionMode,
          marker: vars.marker,
          streamPath: vars.streamPath,
        })}`,
      ),
    );
    if (!streamFetchResponse.ok) {
      throw new Error(
        `Expected iterate-config worker fetch to succeed, got ${streamFetchResponse.status}`,
      );
    }

    const streamFetch = await streamFetchResponse.json();
    const called = await worker.someFunction({
      echo: vars.marker,
      executionMode: vars.executionMode,
    });
    using streams = await ctx.streams;
    const streamEvents = await streams.read({ afterOffset: "start", streamPath: vars.streamPath });

    return { called, streamEvents, streamFetch };
  });

/**
 * Project-context script: calls `ctx.project.fetch(...)` and
 * `ctx.project.egressFetch(...)`.
 *
 * This proves the project capability exposes the Project Durable Object's public
 * fetch surfaces directly: ingress fetch returns the project homepage, and
 * egress fetch runs through project secret substitution. The return shape is
 * deliberately plain JSON so the same script can run through `/run` and CLI.
 */
export const fetchAndEgressProject = capnwebScript
  .vars<{
    echoAuthToken: string;
    echoUrl: string;
    executionMode: string;
    ingressUrl: string;
    secretKey: string;
  }>()
  .define(async ({ ctx, vars }) => {
    using project = await ctx.project;
    const expectedHomepageText = "Hello from the project config worker";
    let ingress = { status: 0, text: "" };
    for (let attempt = 0; attempt < 12; attempt++) {
      // ctx.project.fetch is the Project Durable Object ingress fetch.
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
    // ctx.project.egressFetch is the Project Durable Object egress path,
    // including project secret substitution.
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
      executionMode: vars.executionMode,
      ingress,
    };
  });

/**
 * Project-context script: calls bare global `fetch(...)` with a getSecret(...)
 * header.
 *
 * This is the codemode-global-fetch proof. The script does not mention
 * `ctx.project.egressFetch`; each runner must install global fetch as the
 * project egress gateway. The node e2e test runs this same function through
 * Vitest's direct runner, `/api/captnweb/run`, and `src/capnweb/cli.ts`.
 */
export const globalFetchUsesProjectEgress = capnwebScript
  .vars<{
    echoAuthToken: string;
    echoUrl: string;
    executionMode: string;
    secretKey: string;
  }>()
  .define(async ({ vars }) => {
    const headerName = "x-iterate-global-fetch-secret";
    const secretReference = `Bearer getSecret({ key: ${JSON.stringify(vars.secretKey)} })`;
    const response = await fetch(vars.echoUrl, {
      headers: {
        authorization: `Bearer ${vars.echoAuthToken}`,
        [headerName]: secretReference,
      },
    });
    const body = (await response.json()) as {
      headers?: Record<string, string | string[] | undefined>;
      url?: string;
    };
    const echoedHeader =
      body.headers?.[headerName] ?? body.headers?.["X-Iterate-Global-Fetch-Secret"];
    const echoedSecretHeader = Array.isArray(echoedHeader)
      ? echoedHeader.join(", ")
      : String(echoedHeader ?? "");

    return {
      echoedSecretHeader,
      executionMode: vars.executionMode,
      secretReferenceWasSubstituted: echoedSecretHeader !== secretReference,
      status: response.status,
    };
  });
