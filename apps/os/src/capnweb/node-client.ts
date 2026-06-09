import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { IterateContext } from "./iterate-context-capability.ts";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";

const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

export type NodeIterateContextSession = {
  ctx: RpcStub<IterateContext>;
  close(): void;
};

export async function connectNodeIterateContext(input: {
  baseUrl?: string;
  projectId?: string;
}): Promise<NodeIterateContextSession> {
  const baseUrl = input.baseUrl ?? requireBaseUrl();
  const authHeaders = rootAccessAuthHeaders();
  const sockets: WebSocket[] = [];

  const rootSocket = new WebSocket(rootWebSocketUrl(baseUrl), { headers: authHeaders });
  sockets.push(rootSocket);
  const root = newWebSocketRpcSession<IterateContext>(
    rootSocket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );

  const ctx = input.projectId
    ? await projectContext({ authHeaders, baseUrl, projectId: input.projectId, root, sockets })
    : root;

  return {
    ctx,
    close() {
      for (const socket of sockets) socket.close();
    },
  };
}

export async function runWithProjectEgressFetch<T>(
  ctx: RpcStub<IterateContext>,
  run: () => T | Promise<T>,
): Promise<T> {
  // This is the Node-side version of codemode's outbound gateway. It gives
  // local CLI/REPL snippets the same authoring model as /run and real codemode
  // workers: bare fetch(...) goes through ctx.project.egressFetch so project
  // secret references are substituted. Root-only contexts that call fetch()
  // fail at ctx.project, which is the right signal: there is no project egress
  // authority in scope.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => projectEgressFetch(ctx, ...args);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function projectEgressFetch(
  ctx: RpcStub<IterateContext>,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  return await ctx.project.egressFetch(new Request(input, init));
}

async function projectContext(input: {
  authHeaders: Record<string, string>;
  baseUrl: string;
  projectId: string;
  root: RpcStub<IterateContext>;
  sockets: WebSocket[];
}) {
  using projects = await input.root.projects;
  const summary = await projects.find({ id: input.projectId });
  const { headers, wsUrl } = projectWebSocketRequest({
    authHeaders: input.authHeaders,
    baseUrl: input.baseUrl,
    ingressUrl: summary.ingressUrl,
  });
  const socket = new WebSocket(wsUrl.toString(), { headers });
  input.sockets.push(socket);
  const project = newWebSocketRpcSession<ProjectCapabilityApi>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  return project.getIterateContext() as unknown as RpcStub<IterateContext>;
}

function rootWebSocketUrl(baseUrl: string) {
  const wsUrl = new URL(ROOT_ITERATE_CONTEXT_PREFIX, baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return wsUrl.toString();
}

function projectWebSocketRequest(input: {
  authHeaders: Record<string, string>;
  baseUrl: string;
  ingressUrl: string;
}) {
  const base = new URL(input.baseUrl);
  const ingress = new URL(input.ingressUrl);
  const wsUrl = new URL(
    PROJECT_CAPNWEB_PATH,
    base.hostname === "localhost" || base.hostname === "127.0.0.1" ? base : ingress,
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    headers: {
      ...input.authHeaders,
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

function rootAccessAuthHeaders() {
  const token =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS_E2E_BEARER_TOKEN?.trim();
  if (!token) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required. Run through Doppler.");
  return { Authorization: `Bearer ${token}` };
}

function requireBaseUrl() {
  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("APP_CONFIG_BASE_URL is required. Run through Doppler.");
  return baseUrl;
}
