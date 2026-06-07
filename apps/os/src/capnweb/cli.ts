#!/usr/bin/env npx tsx
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import { liftLocalProxies } from "./local-proxy-wrapper.js";
import type { IterateContext } from "./iterate-context-capability.ts";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";

const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || !flags.e) {
    printUsage();
    process.exit(flags.help ? 0 : 1);
  }

  const baseUrl = requireBaseUrl();
  const authHeaders = rootAccessAuthHeaders();
  const sockets: WebSocket[] = [];
  try {
    const rootSocket = new WebSocket(rootWebSocketUrl(baseUrl), { headers: authHeaders });
    sockets.push(rootSocket);
    const root = liftLocalProxies(
      newWebSocketRpcSession<IterateContext>(
        rootSocket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
      ),
    );

    const ctx = flags["project-id"]
      ? await projectContext({
          authHeaders,
          baseUrl,
          projectId: flags["project-id"],
          root,
          sockets,
        })
      : root;
    const fn = (0, eval)(`(${flags.e})`) as (input: {
      ctx: RpcStub<IterateContext>;
      env: Record<string, unknown>;
      vars: Record<string, unknown>;
    }) => unknown;
    const result = await fn({ ctx, env: {}, vars: parseJsonObject(flags.vars ?? "{}") });
    console.log(JSON.stringify(result));
  } finally {
    for (const socket of sockets) socket.close();
  }
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
  return liftLocalProxies(project.getIterateContext() as unknown as RpcStub<IterateContext>);
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

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const name = arg === "-e" ? "e" : arg.replace(/^--?/, "");
    if (name === "help") {
      flags.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags[name] = value;
    index++;
  }
  return flags as { e?: string; help?: boolean; "project-id"?: string; vars?: string };
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--vars must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
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

function printUsage() {
  console.log(`Usage:
  doppler run -- pnpm exec tsx src/capnweb/cli.ts --project-id <proj_...> -e "async ({ ctx }) => await (await ctx.project).describe()"
  doppler run -- pnpm exec tsx src/capnweb/cli.ts -e "async ({ ctx }) => await (await ctx.projects).list()"
`);
}
