import { createORPCClient } from "@orpc/client";
import {
  RPCLink as WebSocketRPCLink,
  type LinkWebsocketClientOptions,
} from "@orpc/client/websocket";
import { oc, type ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland/service-contract";
import type { ServiceManifestWithEntryPoint } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

export const PingOutput = z.object({
  message: z.string(),
  serverTime: z.string(),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "ws-test-2 service health metadata",
  sqlSummary: "Execute SQL against ws-test-2 service database",
  debugSummary: "ws-test-2 service runtime debug details",
});

export const wsTest2Contract = oc.router({
  ...serviceSubRouter,
  ping: oc
    .route({
      method: "GET",
      path: "/ping",
      summary: "Ping over oRPC HTTP",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(PingOutput),
});

export const WsTest2ServiceEnv = z.object({
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(17302),
});

export type WsTest2ServiceEnv = z.infer<typeof WsTest2ServiceEnv>;
export type WsTest2Client = ContractRouterClient<typeof wsTest2Contract>;
export type WsTest2RpcWebSocket = LinkWebsocketClientOptions["websocket"];

function toBasePath(url?: string): string {
  if (!url) return "";

  if (/^https?:\/\//.test(url)) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/(?:api(?:\/orpc\/ws)?|orpc(?:\/ws)?)\/?$/, "")}`;
  }

  return url.replace(/\/(?:api(?:\/orpc\/ws)?|orpc(?:\/ws)?)\/?$/, "");
}

function joinPath(basePath: string, suffix: string) {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}${suffix}`;
}

function toWebSocketUrl(basePath: string) {
  const fallbackOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:17302";
  const url = new URL(joinPath(basePath, "/api/orpc/ws"), fallbackOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createWsTest2Client(params?: {
  url?: string;
  fetch?: typeof fetch;
}): WsTest2Client {
  const basePath = toBasePath(params?.url);
  const fallbackOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:17302";
  const link = new OpenAPILink(wsTest2Contract, {
    url: new URL(joinPath(basePath, "/api"), fallbackOrigin).toString(),
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
  return createORPCClient(link);
}

export function createWsTest2WebSocketClient(params?: {
  url?: string;
  websocket?: WsTest2RpcWebSocket;
}): WsTest2Client {
  const websocket =
    params?.websocket ?? new WebSocket(toWebSocketUrl(toBasePath(params?.url)), ["orpc"]);
  const link = new WebSocketRPCLink({ websocket });
  return createORPCClient(link);
}

export function getWsTest2ServiceEnv(raw: Record<string, string | undefined> = process.env) {
  return WsTest2ServiceEnv.parse(raw);
}

export { PingOutput as pingOutputSchema, WsTest2ServiceEnv as wsTest2ServiceEnvSchema };

export const wsTest2ServiceManifest = {
  name: packageJson.name,
  slug: "ws-test-2",
  serviceName: "ws-test",
  displayName: "ws-test",
  version: packageJson.version ?? "0.0.0",
  port: 17302,
  serverEntryPoint: "services/ws-test-2/src/node.ts",
  orpcContract: wsTest2Contract,
  envVars: WsTest2ServiceEnv,
  frontendTitle: "ws-test",
  apiBasePath: "/api",
  orpcWebSocketPath: "/api/orpc/ws",
} as const satisfies ServiceManifestWithEntryPoint;
