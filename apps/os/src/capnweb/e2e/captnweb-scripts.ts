import type { IterateContext } from "../iterate-context-capability.ts";

export type BuiltinCapnwebContext = IterateContext;

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
   * capability tree. Runtime wiring still comes from the runner.
   */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    type ReplacementCtx = Mode extends "extend" ? Ctx & NewCtx : NewCtx;
    return this as unknown as CapnwebScriptBuilder<ReplacementCtx, Vars>;
  }
}

export const capnwebScript = new CapnwebScriptBuilder();

export function buildIterateConfigWorkerSource(input: { marker: string }) {
  return `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ctx = await env.ITERATE.context;
    const projectId = url.searchParams.get("projectId");
    const streamPath = url.searchParams.get("streamPath");
    const eventType = url.searchParams.get("eventType");
    const marker = url.searchParams.get("marker");
    const project = ctx.projects.get(projectId);
    const streams = project.streams;
    const stream = streams.get(streamPath);

    // Stream reads are immediately consistent, but listing can lag briefly in
    // deployed environments. Poll only the listing assertion.
    const beforeStreams = await streams.list();
    const listUntilStreamAppears = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const listedStreams = await streams.list();
        if (listedStreams.some((stream) => stream.streamPath === streamPath)) {
          return listedStreams;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return streams.list();
    };

    const appended = await stream.append({
      type: eventType,
      payload: { marker, source: "iterate-config" },
    });
    const afterStreams = await listUntilStreamAppears();

    return Response.json({
      appended: {
        eventType: appended.type,
        marker: appended.payload.marker,
        offset: appended.offset,
        streamPath,
      },
      events: await stream.read({ afterOffset: "start" }),
      streamNames: afterStreams.map((stream) => stream.name),
      streamWasListedBeforeAppend: beforeStreams.some(
        (stream) => stream.streamPath === streamPath,
      ),
      streamWasListedAfterAppend: afterStreams.some(
        (stream) => stream.streamPath === streamPath,
      ),
    });
  },

  async someFunction(input = {}) {
    return { from: "iterate-config", input, marker: ${JSON.stringify(input.marker)} };
  },
};
`.trim();
}

export const describeProjectThroughProjects = capnwebScript
  .vars<{ projectId: string }>()
  .define(({ ctx, vars }) => {
    // Start at the root Iterate capability, select a project, and ask the
    // project to describe itself.
    return ctx.projects.get(vars.projectId).describe();
  });

export const appendAndReadProjectStream = capnwebScript
  .vars<{
    eventType: string;
    marker: string;
    projectId: string;
    streamPath: string;
  }>()
  .define(async ({ ctx, vars }) => {
    // Project child capabilities inherit the project namespace, so this stream
    // path is just "/something", not "proj_123:/something".
    const stream = ctx.projects.get(vars.projectId).streams.get(vars.streamPath);

    // Appending returns the stored event. Reading from the same stream returns
    // the event again through the durable stream API.
    const appended = await stream.append({
      type: vars.eventType,
      payload: { marker: vars.marker },
    });

    return {
      appended,
      events: await stream.read({ afterOffset: "start" }),
    };
  });

export const proveStreamNamespaceCurrying = capnwebScript
  .vars<{
    eventType: string;
    marker: string;
    projectId: string;
    projectSlug: string;
    streamPath: string;
  }>()
  .define(async ({ ctx, vars }) => {
    // These three handles address the same stream. The project path curries the
    // namespace; the root stream collection accepts the namespace explicitly.
    const projectStream = ctx.projects.get(vars.projectId).streams.get(vars.streamPath);
    const rootObjectStream = ctx.streams.get({
      namespace: vars.projectId,
      path: vars.streamPath,
    });
    const rootStringStream = ctx.streams.get(`${vars.projectId}:${vars.streamPath}`);

    const appended = await projectStream.append({
      type: vars.eventType,
      payload: { marker: vars.marker, source: "project-curried" },
    });

    return {
      appended,
      objectRead: await rootObjectStream.read({ afterOffset: "start" }),
      projectById: await ctx.projects.get(vars.projectId).describe(),
      projectBySlug: await ctx.projects.get(vars.projectSlug).describe(),
      rootObjectDescription: await rootObjectStream.describe(),
      rootStringDescription: await rootStringStream.describe(),
      stringRead: await rootStringStream.read({ afterOffset: "start" }),
    };
  });

export const callProjectConnection = capnwebScript
  .vars<{ connectionKey: string; projectId: string; source: string }>()
  .define(async ({ ctx, vars }) => {
    // Connections are capabilities that the project is holding on behalf of
    // another process. From script code they look like ordinary objects.
    const connection = (await ctx.projects
      .get(vars.projectId)
      .connections.get(vars.connectionKey)) as unknown as {
      echo(input: { source: string }): unknown;
    };
    return connection.echo({ source: vars.source });
  });

export const updateIterateConfigAndCallWorker = capnwebScript
  .vars<{
    dir: string;
    marker: string;
    projectId: string;
    workerSource: string;
  }>()
  .define(async ({ ctx, vars }) => {
    // The project owns its iterate-config repo. The script can use normal repo
    // and workspace capabilities to edit worker.js and push it.
    const project = ctx.projects.get(vars.projectId);
    const workspace = project.workspaces.get("capnweb");
    const repo = await project.repos.ensureIterateConfigInfo({ projectSlug: null });
    const git = workspace.git;

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
      message: `Add capnweb worker proof for ${vars.marker}`,
    });
    await git.push({
      dir: vars.dir,
      ref: repo.defaultBranch,
      remote: "origin",
      ...repo.credentials,
    });

    // Once the repo update lands, the project worker is available as a normal
    // child capability.
    return {
      calledTool: await project.worker.someFunction({ echo: vars.marker }),
      project: await project.describe(),
      repoSlug: repo.slug,
      workspaceGitPath: 'ctx.projects.get(projectId).workspaces.get("capnweb").git',
    };
  });

export const callUpdatedIterateConfigWorker = capnwebScript
  .vars<{
    eventType: string;
    marker: string;
    projectId: string;
    streamPath: string;
  }>()
  .define(async ({ ctx, vars }) => {
    // Call the same project worker both as a fetch handler and as an RPC-style
    // tool. The worker itself uses env.ITERATE.context internally.
    const project = ctx.projects.get(vars.projectId);
    const worker = project.worker;
    const streamFetchResponse = await worker.fetch(
      new Request(
        `https://iterate-config.local/capnweb-fetch/${vars.marker}?${new URLSearchParams({
          eventType: vars.eventType,
          marker: vars.marker,
          projectId: vars.projectId,
          streamPath: vars.streamPath,
        })}`,
      ),
    );
    if (!streamFetchResponse.ok) {
      throw new Error(
        `Expected iterate-config worker fetch to succeed, got ${streamFetchResponse.status}`,
      );
    }

    return {
      called: await worker.someFunction({ echo: vars.marker }),
      streamEvents: await ctx.streams
        .get({ namespace: vars.projectId, path: vars.streamPath })
        .read({ afterOffset: "start" }),
      streamFetch: await streamFetchResponse.json(),
    };
  });

export const fetchAndEgressProject = capnwebScript
  .vars<{
    echoAuthToken: string;
    echoUrl: string;
    ingressUrl: string;
    projectId: string;
    secretKey: string;
  }>()
  .define(async ({ ctx, vars }) => {
    // Project fetch goes through the project ingress path. This retries because
    // the freshly-created project's default worker can still be warming.
    const project = ctx.projects.get(vars.projectId);
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
    const body = (await egressResponse.json()) as EchoResponse;
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
  });

export const globalFetchUsesProjectEgress = capnwebScript
  .vars<{
    echoAuthToken: string;
    echoUrl: string;
    secretKey: string;
  }>()
  .define(async ({ vars }) => {
    // Codemode scripts use normal fetch(). The runner decides that, in a
    // project-scoped context, outbound fetches should go through project egress.
    const headerName = "x-iterate-global-fetch-secret";
    const secretReference = `Bearer getSecret({ key: ${JSON.stringify(vars.secretKey)} })`;
    const response = await fetch(vars.echoUrl, {
      headers: {
        authorization: `Bearer ${vars.echoAuthToken}`,
        [headerName]: secretReference,
      },
    });
    const body = (await response.json()) as EchoResponse;
    const echoedHeader =
      body.headers?.[headerName] ?? body.headers?.["X-Iterate-Global-Fetch-Secret"];
    const echoedSecretHeader = Array.isArray(echoedHeader)
      ? echoedHeader.join(", ")
      : String(echoedHeader ?? "");

    return {
      echoedSecretHeader,
      secretReferenceWasSubstituted: echoedSecretHeader !== secretReference,
      status: response.status,
    };
  });

type EchoResponse = {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
};
