import { afterAll, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import dedent from "dedent";
import WebSocket from "ws";
import { Redacted } from "@iterate-com/shared/apps/config";
import {
  requireAdminBearerToken,
  requireBaseUrl,
  uniqueSuffix,
} from "../test-support/os-client.ts";
import type { IterateAdminCapability } from "../../src/capnweb/admin-capability.ts";
import type { IterateContext } from "../../src/capnweb/iterate-context-capability.ts";

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
    const project = await admin.projects.create({
      slug: `${testRunSlugPrefix}-crud-${uniqueSuffix()}`.slice(0, 40),
    });
    try {
      expect(project).toMatchObject({ id: expect.stringMatching(/^proj_/) });
      const list = await admin.projects.list({ limit: 1_000 });
      expect(list.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: project.id, slug: project.slug })]),
      );
      expect(await admin.projects.get(project.id).project.describe()).toMatchObject({
        id: project.id,
        slug: project.slug,
      });
      expect(await admin.projects.remove({ id: project.id })).toEqual({
        deleted: true,
        id: project.id,
        ok: true,
      });
    } finally {
      await admin.projects.remove({ id: project.id }).catch(() => undefined);
    }
  });

  it("connects directly to the project durable object capnweb session", async () => {
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    const project = await admin.projects.create({
      slug: `${testRunSlugPrefix}-stream-${uniqueSuffix()}`.slice(0, 40),
    });
    try {
      using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
      const streamPath = `/capnweb/project-session/${uniqueSuffix()}`;
      const eventType = "events.iterate.com/capnweb/project-session";
      const marker = `project-session-${uniqueSuffix()}`;
      const appended = await iterate.ctx.streams.append({
        event: { type: eventType, payload: { marker } },
        streamPath,
      });
      const events = await iterate.ctx.streams.read({ afterOffset: "start", streamPath });
      expect(appended).toMatchObject({ payload: { marker }, type: eventType });
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ payload: { marker }, type: eventType })]),
      );
    } finally {
      await admin.projects.remove({ id: project.id }).catch(() => undefined);
    }
  });

  it("updates iterate-config and calls env.ITERATE.ctx from dynamic worker fetch", async () => {
    using admin = withAdminIterateFromNode({ auth, baseUrl });
    const project = await admin.projects.create({
      slug: `${testRunSlugPrefix}-worker-${uniqueSuffix()}`.slice(0, 40),
    });
    try {
      using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
      const marker = `capnweb-worker-${uniqueSuffix()}`;
      const streamPath = `/capnweb/worker/${marker}`;
      const eventType = `events.iterate.com/capnweb/worker/${marker}`;
      const workerSource = dedent`
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const ctx = env.ITERATE.getContext();
            const streamPath = url.searchParams.get("streamPath");
            const eventType = url.searchParams.get("eventType");
            const marker = url.searchParams.get("marker");
            const appended = await ctx.streams.append({
              streamPath,
              event: {
                type: eventType,
                payload: { marker, source: "iterate-config" },
              },
            });
            const events = await ctx.streams.read({ afterOffset: "start", streamPath });
            return Response.json({
              appended: {
                eventType: appended.type,
                marker: appended.payload.marker,
                offset: appended.offset,
                streamPath,
              },
              events,
            });
          },
          async someFunction(input = {}) {
            return { from: "iterate-config", input, marker: ${JSON.stringify(marker)} };
          },
        };
      `;

      const repo = await iterate.ctx.repos.ensureIterateConfigInfo({ projectSlug: null });
      const dir = `/iterate-config-${Date.now()}`;
      await iterate.ctx.workspace.git.clone({
        branch: repo.defaultBranch,
        depth: 1,
        dir,
        url: repo.remote,
        ...repo.credentials,
      });
      await iterate.ctx.workspace.writeFile(`${dir}/worker.js`, workerSource);
      await iterate.ctx.workspace.git.add({ dir, filepath: "worker.js" });
      await iterate.ctx.workspace.git.commit({
        author: { name: "Capnweb", email: "captnweb-e2e@iterate.com" },
        dir,
        message: "Add capnweb worker proof",
      });
      await iterate.ctx.workspace.git.push({
        dir,
        ref: repo.defaultBranch,
        remote: "origin",
        ...repo.credentials,
      });

      const streamFetch = (await iterate.ctx.worker.fetchJson({
        url: `https://iterate-config.local/capnweb-fetch/${marker}?${new URLSearchParams({
          eventType,
          marker,
          streamPath,
        })}`,
      })) as { appended: unknown; events: unknown[] };
      const called = await iterate.ctx.worker.call({
        args: [{ echo: marker }],
        functionName: "someFunction",
      });
      const streamEvents = await iterate.ctx.streams.read({ afterOffset: "start", streamPath });

      expect(called).toEqual({ from: "iterate-config", input: { echo: marker }, marker });
      expect(streamFetch.appended).toMatchObject({
        eventType,
        marker,
        offset: expect.any(Number),
        streamPath,
      });
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
    } finally {
      await admin.projects.remove({ id: project.id }).catch(() => undefined);
    }
  });
});

function withAdminIterateFromNode(input: {
  auth: AdminAuth;
  baseUrl: string;
}): RpcStub<IterateAdminCapability> {
  const wsUrl = new URL(ADMIN_CAPNWEB_PREFIX, input.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl.toString(), { headers: adminAuthHeaders(input.auth) });
  return newWebSocketRpcSession<IterateAdminCapability>(
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

async function listProjectsWithSlugPrefix(prefix: string) {
  const matches: Array<{ id: string; slug: string }> = [];
  const limit = 100;
  using admin = withAdminIterateFromNode({ auth, baseUrl });
  for (let offset = 0; ; offset += limit) {
    const page = await admin.projects.list({ limit, offset });
    matches.push(...page.projects.filter((project) => project.slug.startsWith(prefix)));
    if (offset + page.projects.length >= page.total || page.projects.length === 0) return matches;
  }
}
