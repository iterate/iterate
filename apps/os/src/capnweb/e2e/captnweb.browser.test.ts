import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "../../domains/secrets/example-secret.ts";
import { liftLocalProxies } from "../local-proxy-wrapper.js";
import type { IterateContext } from "../iterate-context-capability.ts";
import type { ProjectCapabilityApi } from "../../domains/projects/durable-objects/project-durable-object.ts";
import {
  appendAndReadProjectStream,
  buildIterateConfigWorkerSource,
  callUpdatedIterateConfigWorker,
  describeProjectThroughProjects,
  fetchAndEgressProject,
  updateIterateConfigAndCallWorker,
  type CapnwebScript,
} from "./captnweb-scripts.ts";

declare const __CAPNWEB_BROWSER_E2E__: {
  adminApiSecret: string;
  baseUrl: string;
};

const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

describe("capnweb browser execution mode", () => {
  const createdProjectIds: string[] = [];

  afterAll(async () => {
    using root = await withRootIterateFromBrowser();
    using projects = await root.projects;
    for (const id of createdProjectIds.toReversed()) {
      await projects.remove({ id }).catch(() => {});
    }
  });

  it("runs codemode-shaped scripts through browser Cap'n Web stubs", async () => {
    using root = await withRootIterateFromBrowser();
    using projects = await root.projects;
    const project = await projects.create({
      slug: `captnweb-browser-${uniqueSuffix()}`.slice(0, 40),
    });
    createdProjectIds.push(project.id);

    await expect(
      runBrowserCapnwebScript({
        ctx: root,
        script: describeProjectThroughProjects,
        vars: { executionMode: "browser", projectId: project.id },
      }),
    ).resolves.toMatchObject({
      executionMode: "browser",
      id: project.id,
      slug: project.slug,
    });

    using iterate = await withIterateFromBrowser({ ingressUrl: project.ingressUrl });
    const marker = `browser-${uniqueSuffix()}`;
    const streamPath = `/capnweb/browser/${marker}`;
    const eventType = `events.iterate.com/capnweb/browser/${marker}`;
    const streamResult = await runBrowserCapnwebScript({
      ctx: iterate.ctx,
      script: appendAndReadProjectStream,
      vars: { eventType, executionMode: "browser", marker, streamPath },
    });
    expect(streamResult.appended).toMatchObject({
      payload: { executionMode: "browser", marker },
      type: eventType,
    });
    expect(streamResult.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { executionMode: "browser", marker },
          type: eventType,
        }),
      ]),
    );

    const fetchResult = await runBrowserCapnwebScript({
      ctx: iterate.ctx,
      script: fetchAndEgressProject,
      vars: {
        echoAuthToken: __CAPNWEB_BROWSER_E2E__.adminApiSecret,
        echoUrl: new URL("/api/captnweb/egress-echo", __CAPNWEB_BROWSER_E2E__.baseUrl).toString(),
        executionMode: "browser",
        ingressUrl: project.ingressUrl,
        secretKey: EXAMPLE_EGRESS_SECRET_KEY,
      },
    });
    expect(fetchResult.ingress).toMatchObject({
      status: 200,
      text: "Hello from the project config worker",
    });
    expect(fetchResult.egress).toMatchObject({
      echoedSecretHeader: `Bearer ${EXAMPLE_EGRESS_SECRET_MATERIAL}`,
      secretReferenceWasSubstituted: true,
      status: 200,
    });

    const workerMarker = `browser-worker-${uniqueSuffix()}`;
    const workerStreamPath = `/capnweb/browser-worker/${workerMarker}`;
    const workerEventType = `events.iterate.com/capnweb/browser-worker/${workerMarker}`;
    const updateResult = await runBrowserCapnwebScript({
      ctx: iterate.ctx,
      script: updateIterateConfigAndCallWorker,
      vars: {
        dir: `/iterate-config-browser-${Date.now()}`,
        executionMode: "browser",
        marker: workerMarker,
        workerSource: buildIterateConfigWorkerSource({ marker: workerMarker }),
      },
    });
    expect(updateResult).toMatchObject({
      calledTool: {
        from: "iterate-config",
        input: { echo: workerMarker, executionMode: "browser" },
        marker: workerMarker,
      },
      executionMode: "browser",
      project: { id: project.id, slug: project.slug },
      repoSlug: "iterate-config",
      workspaceGitPath: "ctx.project.workspace.git",
    });

    const workerCallResult = await runBrowserCapnwebScript({
      ctx: iterate.ctx,
      script: callUpdatedIterateConfigWorker,
      vars: {
        eventType: workerEventType,
        executionMode: "browser",
        marker: workerMarker,
        streamPath: workerStreamPath,
      },
    });
    expect(workerCallResult.called).toMatchObject({
      from: "iterate-config",
      input: { echo: workerMarker, executionMode: "browser" },
      marker: workerMarker,
    });
    expect(workerCallResult.streamFetch.appended).toMatchObject({
      eventType: workerEventType,
      executionMode: "browser",
      marker: workerMarker,
      offset: expect.any(Number),
      streamPath: workerStreamPath,
    });
    expect(workerCallResult.streamFetch.streamWasListedAfterAppend).toBe(true);
    expect(workerCallResult.streamFetch.streamNames).toEqual(
      expect.arrayContaining([`${project.id}:${workerStreamPath}`]),
    );
    expect(workerCallResult.streamEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { executionMode: "browser", marker: workerMarker, source: "iterate-config" },
          type: workerEventType,
        }),
      ]),
    );
  }, 30_000);
});

async function runBrowserCapnwebScript(input: {
  ctx: RpcStub<IterateContext>;
  script: CapnwebScript<any, any, any>;
  vars?: Record<string, unknown>;
}): Promise<any> {
  return await input.script({ ctx: input.ctx, env: {}, vars: input.vars ?? {} });
}

async function withRootIterateFromBrowser(): Promise<RpcStub<IterateContext>> {
  await setCapnwebAdminCookie(new URL(`${ROOT_ITERATE_CONTEXT_PREFIX}/admin-cookie`, baseUrl()));
  const wsUrl = new URL(ROOT_ITERATE_CONTEXT_PREFIX, baseUrl());
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return liftLocalProxies(newWebSocketRpcSession<IterateContext>(new WebSocket(wsUrl)));
}

async function withIterateFromBrowser(input: { ingressUrl: string }): Promise<{
  ctx: RpcStub<IterateContext>;
  [Symbol.dispose](): void;
}> {
  await setCapnwebAdminCookie(new URL(`${PROJECT_CAPNWEB_PATH}/admin-cookie`, input.ingressUrl));
  const wsUrl = new URL(PROJECT_CAPNWEB_PATH, input.ingressUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const project = newWebSocketRpcSession<ProjectCapabilityApi>(new WebSocket(wsUrl));
  const ctxHandle = project.getIterateContext() as unknown as RpcStub<IterateContext>;
  return {
    ctx: liftLocalProxies(ctxHandle),
    [Symbol.dispose]() {
      ctxHandle[Symbol.dispose]?.();
      project[Symbol.dispose]?.();
    },
  };
}

async function setCapnwebAdminCookie(url: URL) {
  // Browser WebSocket constructors cannot send Authorization headers. In
  // deployed HTTPS, `/admin-cookie` can set this cookie directly. In local
  // Vitest browser mode, the test page lives on Vitest's own origin, so
  // Chromium's local HTTP cookie rules can suppress cross-origin Set-Cookie.
  // The command installs the same cookie through Playwright's browser context.
  const result = await (commands as any).setCapnwebAdminCookie({
    secret: __CAPNWEB_BROWSER_E2E__.adminApiSecret,
    url: url.toString(),
  });
  if (!result.cookies?.some((cookie: { name: string }) => cookie.name === "iterate-admin-auth")) {
    throw new Error(`iterate-admin-auth cookie was not installed for ${url.origin}`);
  }
}

function baseUrl() {
  if (!__CAPNWEB_BROWSER_E2E__.baseUrl) throw new Error("APP_CONFIG_BASE_URL is required.");
  return __CAPNWEB_BROWSER_E2E__.baseUrl;
}

function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}
