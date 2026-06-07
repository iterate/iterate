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
import type { ProjectCapabilityApi } from "../../src/domains/projects/durable-objects/project-durable-object.ts";

/**
 * Cap'n Web capability integration tests.
 *
 * These tests are intentionally written as examples of the coding model we want
 * people to copy:
 *
 * - The main scenario scripts loop over `capnwebToolExecutionModes`: today that
 *   is Node over a Cap'n Web WebSocket session and the `/api/captnweb/run`
 *   dynamic worker. A future Workers for Platforms deployment path should be
 *   another entry in that same list. This forces shared scripts to return
 *   serializable results and proves the symmetric coding model end to end.
 * - `ctx` is an IterateContext: a scoped wrapper around the root Iterate
 *   capability tree. The scopes decide which project shortcuts and mounts are
 *   available.
 * - Project-scoped code can update the iterate-config git repo, then call the
 *   updated worker as `ctx.project.worker.someTool(...)`.
 * - A project can accept a Cap'n Web connection from the test runner and expose
 *   that parent-owned RpcTarget back to codemode/dynamic-worker code.
 * - Mount props can add target, method, ctx-shortcut, and SDK-style paths while
 *   preserving the same `ctx.some.path.method(...)` authoring model.
 */
const baseUrl = requireBaseUrl();
const egressEchoBaseUrl = requireEgressEchoBaseUrl(baseUrl);
const auth = rootAccessAuth();
const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

describe("capnweb", () => {
  const testRunSlugPrefix = `captnweb-${crypto.randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    const remaining = await listProjectsWithSlugPrefix(testRunSlugPrefix);
    expect(remaining).toEqual([]);
  });

  // Scenario: root context can administer projects, and the same project code
  // can run from Node or from the /run dynamic worker.
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

    const describeProjectThroughProjects = async ({ ctx, vars }: CapnwebScriptInput) => {
      using projects = await ctx.projects;
      using project = await projects.get(vars.projectId);
      return { ...(await project.describe()), executionMode: vars.executionMode };
    };

    for (const executionMode of capnwebToolExecutionModes({ ctx: root })) {
      expect(
        await executionMode.runTool({
          script: describeProjectThroughProjects,
          vars: { executionMode: executionMode.name, projectId: project.id },
        }),
      ).toMatchObject({
        executionMode: executionMode.name,
        id: project.id,
        slug: project.slug,
      });
    }
    expect(await projects.remove({ id: project.id })).toMatchObject({
      deleted: true,
      id: project.id,
      ok: true,
    });
  });

  // Scenario: a project ingress can create a project-scoped IterateContext,
  // where ctx.project is the current project and streams are project-local.
  it("connects directly to the project durable object capnweb session", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-stream-${uniqueSuffix()}`.slice(0, 40),
    });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    const streamPath = `/capnweb/project-session/${uniqueSuffix()}`;
    const eventType = "events.iterate.com/capnweb/project-session";
    const appendAndReadProjectStream = async ({ ctx, vars }: CapnwebScriptInput) => {
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
    };

    for (const executionMode of capnwebToolExecutionModes({
      ctx: iterate.ctx,
      props: { scopes: { projects: [project.id] } },
    })) {
      const marker = `project-session-${executionMode.name}-${uniqueSuffix()}`;
      const result = await executionMode.runTool({
        script: appendAndReadProjectStream,
        vars: { eventType, executionMode: executionMode.name, marker, streamPath },
      });
      expect(result.appended).toMatchObject({
        payload: { executionMode: executionMode.name, marker },
        type: eventType,
      });
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: { executionMode: executionMode.name, marker },
            type: eventType,
          }),
        ]),
      );
    }
  });

  // Scenario: the test runner can provide an RpcTarget to a project, then code
  // running elsewhere can call it through ctx.project.connections.
  it("calls a project Cap'n Web connection from node and dynamic worker code", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-connection-${uniqueSuffix()}`.slice(0, 40),
    });
    const connectionKey = `connection-${uniqueSuffix()}`;
    const connectionMethodName = `method-${uniqueSuffix()}`;
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    using projectContext = await iterate.ctx.project;
    // The project accepts a parent-owned RpcTarget and makes it available to
    // code running later through the project's IterateContext.
    await projectContext.provideCapability({
      connectionKey,
      rpcTarget: new ProjectConnectionTestTarget({
        marker: connectionKey,
        methodName: connectionMethodName,
      }),
    });

    const callProjectConnection = async ({ ctx, vars }: CapnwebScriptInput) => {
      using project = await ctx.project;
      using connections = await project.connections;
      using connection = await connections.get(vars.connectionKey);
      return await connection[vars.methodName]({ source: vars.source });
    };

    const executionModes = capnwebToolExecutionModes({
      ctx: iterate.ctx,
      props: { scopes: { projects: [project.id] } },
    });
    for (const [index, executionMode] of executionModes.entries()) {
      expect(
        await executionMode.runTool({
          script: callProjectConnection,
          vars: {
            connectionKey,
            methodName: connectionMethodName,
            source: executionMode.name,
          },
        }),
      ).toMatchObject({
        callCount: index + 1,
        marker: connectionKey,
        source: executionMode.name,
      });
    }
  });

  // Scenario: codemode-style code updates iterate-config in git, then calls
  // the new config worker through ctx.project.worker.
  it("updates iterate-config and calls env.ITERATE.context from dynamic worker fetch", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-worker-${uniqueSuffix()}`.slice(0, 40),
    });
    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    for (const executionMode of capnwebToolExecutionModes({
      ctx: iterate.ctx,
      props: { scopes: { projects: [project.id] } },
    })) {
      const marker = `capnweb-worker-${executionMode.name}-${uniqueSuffix()}`;
      const streamPath = `/capnweb/worker/${marker}`;
      const eventType = `events.iterate.com/capnweb/worker/${marker}`;
      const workerSource = dedent`
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            // The iterate-config worker uses the same context binding as /run
            // and codemode scripts. No test-only ctx injection is involved.
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

      const updateResult = await executionMode.runTool({
        script: async ({ ctx, vars }: CapnwebScriptInput) => {
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

          using worker = await project.worker;
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
        },
        vars: {
          dir: `/iterate-config-${executionMode.name}-${Date.now()}`,
          executionMode: executionMode.name,
          marker,
          workerSource,
        },
      });
      expect(updateResult).toMatchObject({
        calledTool: {
          from: "iterate-config",
          input: { echo: marker, executionMode: executionMode.name },
          marker,
        },
        executionMode: executionMode.name,
        project: { id: project.id, slug: project.slug },
        repoSlug: "iterate-config",
        workspaceGitPath: "ctx.project.workspace.git",
      });

      using projectContext = await iterate.ctx.project;
      using worker = (await projectContext.worker) as any;
      // The config worker fetches through the project worker capability; dynamic
      // methods on the same capability are ordinary tool calls.
      const streamFetchResponse = await worker.fetch(
        new Request(
          `https://iterate-config.local/capnweb-fetch/${marker}?${new URLSearchParams({
            eventType,
            executionMode: executionMode.name,
            marker,
            streamPath,
          })}`,
        ),
      );
      expect(streamFetchResponse.ok).toBe(true);
      const streamFetch = (await streamFetchResponse.json()) as any;
      const called = await worker.someFunction({
        echo: marker,
        executionMode: executionMode.name,
      });
      using streams = await iterate.ctx.streams;
      const streamEvents = await streams.read({ afterOffset: "start", streamPath });

      expect(called).toMatchObject({
        from: "iterate-config",
        input: { echo: marker, executionMode: executionMode.name },
        marker,
      });
      expect(streamFetch.appended).toMatchObject({
        eventType,
        executionMode: executionMode.name,
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
            payload: { executionMode: executionMode.name, marker, source: "iterate-config" },
            type: eventType,
          }),
        ]),
      );
      expect(streamEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: { executionMode: executionMode.name, marker, source: "iterate-config" },
            type: eventType,
          }),
        ]),
      );
    }
  });

  // Scenario: project fetch capabilities expose both ingress and egress from
  // the same project capability that codemode receives.
  it("uses codemode ctx.project.fetch and ctx.project.egressFetch from worker.js", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-project-fetch-${uniqueSuffix()}`.slice(0, 40),
    });

    using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
    for (const executionMode of capnwebToolExecutionModes({
      ctx: iterate.ctx,
      props: { scopes: { projects: [project.id] } },
    })) {
      const result = await executionMode.runTool({
        script: async ({ ctx, vars }: CapnwebScriptInput) => {
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
          const echoedHeader =
            body.headers?.[headerName] ?? body.headers?.["X-Iterate-Example-Secret"];
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
        },
        vars: {
          echoAuthToken: auth.token.exposeSecret(),
          echoUrl: new URL("/api/captnweb/egress-echo", egressEchoBaseUrl).toString(),
          executionMode: executionMode.name,
          ingressUrl: project.ingressUrl,
          secretKey: EXAMPLE_EGRESS_SECRET_KEY,
        },
      });

      expect(result.ingress).toMatchObject({
        status: 200,
        text: "Hello from the project config worker",
      });
      expect(result.egress).toMatchObject({
        secretReferenceWasSubstituted: true,
        status: 200,
      });
      expect(result.egress.echoedSecretHeader).toBe(`Bearer ${EXAMPLE_EGRESS_SECRET_MATERIAL}`);
      expect(result.executionMode).toBe(executionMode.name);
    }
  });

  // Scenario: mounts add ergonomic shortcuts without changing the capability
  // model. The same ctx tree handles dynamic workers, ctx-derived shortcuts,
  // method mounts, and Slack-style SDK paths.
  it("applies IterateContext mount props for target, method, sdk markers, and ctx shortcuts", async () => {
    using root = withRootIterateContextFromNode({ auth, baseUrl });
    await using project = await createDisposableProject({
      root,
      slug: `${testRunSlugPrefix}-mounts-${uniqueSuffix()}`.slice(0, 40),
    });
    const marker = `mounts-${uniqueSuffix()}`;
    const streamPath = `/capnweb/mounts/${marker}`;
    const eventType = `events.iterate.com/capnweb/mounts/${marker}`;
    const appendMountName = `append-${uniqueSuffix()}`;
    const listStreamsMountName = `listStreams-${uniqueSuffix()}`;
    const mountedStreamsName = `mountedStreams-${uniqueSuffix()}`;
    const nestedSdkBranchName = `branch-${uniqueSuffix()}`;
    const nestedSdkMountName = `nestedSdk-${uniqueSuffix()}`;
    const nestedSdkRootName = `root-${uniqueSuffix()}`;
    const rootEchoMountName = `rootEcho-${uniqueSuffix()}`;
    const sdkActionName = `postMessage-${uniqueSuffix()}`;
    const sdkGetterName = `sdkGetter-${uniqueSuffix()}`;
    const sdkMountName = `sdk-${uniqueSuffix()}`;
    const sdkNamespaceName = `chat-${uniqueSuffix()}`;
    const toolsMountName = `tools-${uniqueSuffix()}`;
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

      const sdkGetterName = ${JSON.stringify(sdkGetterName)};

      export default class SdkLikeTarget extends WorkerEntrypoint {
        get [sdkGetterName]() {
          // The SDK hierarchy is intentionally unknown. The marker says:
          // "record all properties after this getter and send them to call".
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

    const result = await runCapnwebScriptInDynamicWorker({
      script: async ({ ctx, vars }: CapnwebScriptInput) => {
        using tools = await ctx[vars.toolsMountName];
        const targetResult = await tools.echo({ marker: vars.marker });
        const nestedResult = await tools.nested.describe({ marker: vars.marker });

        const methodResult = await ctx[vars.rootEchoMountName]({ marker: vars.marker });

        using mountedStreams = await ctx[vars.mountedStreamsName];
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
        const listedByMethod = await ctx[vars.listStreamsMountName]();
        const appendResult = await ctx[vars.appendMountName]({
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

        using sdk = await ctx[vars.sdkMountName];
        const sdkResult = await sdk[vars.sdkNamespaceName][vars.sdkActionName]({
          text: vars.marker,
        });
        using nestedSdk =
          await ctx[vars.nestedSdkRootName][vars.nestedSdkBranchName][vars.nestedSdkMountName];
        const nestedSdkResult = await nestedSdk[vars.sdkNamespaceName][vars.sdkActionName]({
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
      },
      props: {
        scopes: { projects: [project.id] },
        // Mounts are part of IterateContext props. The target can be a dynamic
        // worker, or a path derived from the existing ctx capability tree.
        mounts: [
          {
            path: [toolsMountName],
            target: {
              script: toolsScript,
              type: "dynamic-worker",
            },
          },
          {
            invoke: "method",
            path: [rootEchoMountName],
            target: {
              call: ["echo"],
              script: toolsScript,
              type: "dynamic-worker",
            },
          },
          {
            path: [sdkMountName],
            target: {
              call: [sdkGetterName],
              script: sdkScript,
              type: "dynamic-worker",
            },
          },
          {
            path: [nestedSdkRootName, nestedSdkBranchName, nestedSdkMountName],
            target: {
              call: [sdkGetterName],
              script: sdkScript,
              type: "dynamic-worker",
            },
          },
          {
            path: [mountedStreamsName],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams"],
              type: "ctx",
            },
          },
          {
            invoke: "method",
            path: [listStreamsMountName],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams", "list"],
              type: "ctx",
            },
          },
          {
            invoke: "method",
            path: [appendMountName],
            target: {
              call: ["projects", { method: "get", args: [project.id] }, "streams", "append"],
              type: "ctx",
            },
          },
        ],
      },
      vars: {
        appendMountName,
        eventType,
        listStreamsMountName,
        marker,
        mountedStreamsName,
        nestedSdkBranchName,
        nestedSdkMountName,
        nestedSdkRootName,
        rootEchoMountName,
        sdkActionName,
        sdkMountName,
        sdkNamespaceName,
        streamPath,
        toolsMountName,
      },
    });

    expect(result.targetResult).toMatchObject({
      input: { marker },
      kind: "target-method",
      streamCountVisibleFromMountedWorker: expect.any(Number),
    });
    expect(result.nestedResult).toMatchObject({
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
    expect(result.sdkResult).toMatchObject({
      args: [{ text: marker }],
      method: `${sdkNamespaceName}.${sdkActionName}`,
    });
    expect(result.nestedSdkResult).toMatchObject({
      args: [{ text: marker, via: "nested" }],
      method: `${sdkNamespaceName}.${sdkActionName}`,
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

  // Harness guardrail: this is about Vitest's fn.toString() path, not product
  // runtime behavior. Keep ERM repair here instead of in /run worker source.
  it("serializes Vitest-lowered using functions without runtime /run boilerplate", async () => {
    const loweredSource = /* js */ `async function(input) {
      var _stack = [];
      try {
        const disposable = __using(_stack, {
          value: input.vars.value,
          [Symbol.dispose]() {
            input.vars.disposed = true;
          },
        });
        return {
          disposedBeforeReturn: input.vars.disposed,
          value: disposable.value,
        };
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        var _promise = __callDispose(_stack, _error, _hasError);
        _promise && await _promise;
      }
    }`;
    const serialized = serializeCapnwebScriptForDynamicWorker({
      toString: () => loweredSource,
    });
    expect(serialized).toContain("var __using");

    const snippet = new Function(`return ${serialized}`)() as (input: {
      vars: { disposed: boolean; value: string };
    }) => Promise<{ disposedBeforeReturn: boolean; value: string }>;
    const vars = { disposed: false, value: "ok" };

    await expect(snippet({ vars })).resolves.toEqual({
      disposedBeforeReturn: false,
      value: "ok",
    });
    expect(vars.disposed).toBe(true);
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
  const project = newWebSocketRpcSession<ProjectCapabilityApi>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  const ctxHandle = project.getIterateContext() as unknown as RpcStub<IterateContext>;
  const ctx = liftLocalProxies(ctxHandle);
  void Promise.resolve(ctxHandle).catch((error: unknown) => {
    socket.close();
    project[Symbol.dispose]?.();
    throw error;
  });
  return {
    ctx,
    onWsFrame(_frame: unknown) {},
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

// Snippets sent through runCapnwebScriptInDynamicWorker are JavaScript-shaped on
// purpose. The same function body runs in Node and in a dynamic worker, and
// Cap'n Web stubs expose wildcard members at runtime. Keeping `ctx` dynamic here
// makes the test read like codemode code instead of a maze of proxy placeholder
// types.
type CapnwebScriptInput = {
  ctx: any;
  env: Record<string, unknown>;
  vars: any;
};

class ProjectConnectionTestTarget extends RpcTarget {
  constructor(input: { marker: string; methodName: string }) {
    super();
    let callCount = 0;
    Object.defineProperty(Object.getPrototypeOf(this), input.methodName, {
      configurable: true,
      value(callInput: { source: string }) {
        callCount += 1;
        return {
          callCount,
          marker: input.marker,
          source: callInput.source,
        };
      },
    });
  }
}

type CapnwebScript = (input: CapnwebScriptInput) => any;
type CapnwebToolExecutionMode = {
  name: "node-capnweb" | "run-endpoint";
  runTool(input: { script: CapnwebScript; vars?: Record<string, unknown> }): Promise<any>;
};

function capnwebToolExecutionModes(input: {
  ctx: RpcStub<IterateContext>;
  props?: IterateContextProps;
}): CapnwebToolExecutionMode[] {
  // This is the registry of places a codemode/tool script must work. Add the
  // future Workers for Platforms deployment mode here, then the scenario tests
  // will exercise the same scripts through that path without copying test code.
  return [
    {
      name: "node-capnweb",
      runTool: ({ script, vars }) => runCapnwebScriptFromNode({ ctx: input.ctx, script, vars }),
    },
    {
      name: "run-endpoint",
      runTool: ({ script, vars }) =>
        runCapnwebScriptInDynamicWorker({ props: input.props, script, vars }),
    },
  ];
}

async function runCapnwebScriptFromNode(input: {
  ctx: RpcStub<IterateContext>;
  script: CapnwebScript;
  vars?: Record<string, unknown>;
}): Promise<any> {
  return await input.script({ ctx: input.ctx as any, env: {}, vars: input.vars ?? {} });
}

async function runCapnwebScriptInDynamicWorker(input: {
  props?: IterateContextProps;
  script: CapnwebScript;
  vars?: Record<string, unknown>;
}): Promise<any> {
  const url = new URL(`${ROOT_ITERATE_CONTEXT_PREFIX}/run`, baseUrl);
  const response = await fetch(url, {
    body: JSON.stringify({
      functionSource: serializeCapnwebScriptForDynamicWorker(input.script),
      props: input.props,
      vars: input.vars ?? {},
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
  return body;
}

function serializeCapnwebScriptForDynamicWorker(fn: { toString(): string }) {
  const source = fn.toString();
  if (!/\b__(?:using|callDispose)\b/.test(source)) {
    return source;
  }

  // This is deliberately test-helper-only. The `/api/captnweb/run` dynamic
  // worker should execute a normal JavaScript function with almost no wrapper
  // code, and workerd itself supports native `using` on the compatibility date
  // used by that worker.
  //
  // The awkward case is Vitest/Vite/esbuild transforming this test module
  // before fn.toString() runs. If esbuild lowers:
  //
  //   using project = await ctx.project
  //
  // then the function string contains calls to module-scoped helpers like
  // __using(...) and __callDispose(...), but fn.toString() does not include the
  // helper definitions that esbuild emitted around the module. Shipping that
  // bare function string to a dynamic worker would produce ReferenceError.
  //
  // When we detect that lowered shape, we wrap the serialized function in a
  // tiny IIFE that supplies esbuild's own Explicit Resource Management helper
  // preamble. If the function string still contains native `using`, we leave it
  // alone so workerd runs the syntax natively. This keeps the production-ish
  // `/run` worker clean and confines compiler-toolchain repair to the e2e
  // bridge that created the problem by using fn.toString().
  //
  // Source of the helper shape: esbuild's lowering for Explicit Resource
  // Management (`using` / `await using`) when targeting pre-ERM JavaScript.
  // The stack entries are arrays: [async, dispose, value].
  return /* js */ `(() => {
  var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
  var __typeError = (msg) => { throw TypeError(msg); };
  var __using = (stack, value, async) => {
    if (value != null) {
      if (typeof value !== "object" && typeof value !== "function") __typeError("Object expected");
      var dispose, inner;
      if (async) dispose = value[__knownSymbol("asyncDispose")];
      if (dispose === void 0) {
        dispose = value[__knownSymbol("dispose")];
        if (async) inner = dispose;
      }
      if (typeof dispose !== "function") __typeError("Object not disposable");
      if (inner) dispose = function() {
        try {
          inner.call(this);
        } catch (e) {
          return Promise.reject(e);
        }
      };
      stack.push([async, dispose, value]);
    } else if (async) {
      stack.push([async]);
    }
    return value;
  };
  var __callDispose = (stack, error, hasError) => {
    var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
      return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
    };
    var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
    var next = (it) => {
      while (it = stack.pop()) {
        try {
          var result = it[1] && it[1].call(it[2]);
          if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
        } catch (e) {
          fail(e);
        }
      }
      if (hasError) throw error;
    };
    return next();
  };
  return (${source});
})()`;
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
