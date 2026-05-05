import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import handler from "@tanstack/react-start/server-entry";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

// Re-export rpc-targets so loopback-binding callables can resolve them from ctx.exports.
// https://developers.cloudflare.com/workers/runtime-apis/context/#exports
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";
export { ProjectDurableObject } from "~/durable-objects/project-durable-object.ts";
export { ProjectIngressEntrypoint } from "~/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/entrypoints/project-mcp-server-entrypoint.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const durableObjectDebugResponse = await handleDurableObjectDebugFetch({ request, env });
        if (durableObjectDebugResponse) return durableObjectDebugResponse;

        const db = createD1Client(env.DB);
        const projectHostnameBases = config.projectHostnameBases;
        const ingressMatch = await matchIngressRequest({
          request,
          lookupRule: async (host) => {
            const row = await getIngressRouteByHost(db, { host: normalizeIngressHost(host) });
            return row ? ingressRouteRowToRule(row) : null;
          },
        });

        if (ingressMatch) {
          return await dispatchFetchCallable({
            callable: ingressMatch.rule.callable,
            context: {
              env: env as unknown as Record<string, unknown>,
              exports: (cfCtx as ExecutionContext & { exports?: Record<string, unknown> }).exports,
            },
            request,
          });
        }

        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          doCatalog: env.DB,
          log,
          projectHostnameBases,
          loader: env.LOADER,
          codemodeSession: env.CODEMODE_SESSION,
          callableEnv: env,
          project: env.PROJECT,
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};

function ingressRouteRowToRule(row: {
  id: string;
  host: string;
  project_id?: string | null;
  priority: number;
  notes?: string | null;
  callable_json: string;
  created_at: string;
  updated_at: string;
}): ExactHostIngressRule {
  return {
    id: row.id,
    host: row.host,
    projectId: row.project_id ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    callable: parseIngressCallable(row.callable_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleDurableObjectDebugFetch(input: { request: Request; env: Env }) {
  const url = new URL(input.request.url);
  const match = url.pathname.match(/^\/__durable-objects\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const objectKind = match[1];
  const objectName = decodeURIComponent(match[2] ?? "");
  const targetPath = match[3] ?? "/";
  const namespace = readDebugDurableObjectNamespace(input.env, objectKind);
  if (!namespace) {
    return new Response(`Unknown Durable Object debug namespace: ${objectKind}`, { status: 404 });
  }

  const targetUrl = new URL(input.request.url);
  targetUrl.pathname = targetPath;
  const stub = namespace.getByName(objectName);
  return await stub.fetch(new Request(targetUrl, input.request));
}

type DebugDurableObjectNamespace = {
  getByName(name: string): {
    fetch(request: Request): Promise<Response>;
  };
};

function readDebugDurableObjectNamespace(
  env: Env,
  objectKind: string,
): DebugDurableObjectNamespace | null {
  switch (objectKind) {
    case "codemode-session":
      return env.CODEMODE_SESSION as unknown as DebugDurableObjectNamespace;
    case "project":
      return env.PROJECT as unknown as DebugDurableObjectNamespace;
    case "project-mcp-server-connection":
      return env.PROJECT_MCP_SERVER_CONNECTION as unknown as DebugDurableObjectNamespace;
    default:
      return null;
  }
}
