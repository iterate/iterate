import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { exampleContract } from "@iterate-com/example-contract";

export type ExampleClient = ContractRouterClient<typeof exampleContract>;

const FALLBACK_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:17401";

export function createExampleClient(params?: {
  url?: string;
  fetch?: typeof fetch;
}): ExampleClient {
  const base = params?.url ?? FALLBACK_ORIGIN;
  const link = new OpenAPILink(exampleContract, {
    url: `${base}/api`,
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
  return createORPCClient(link);
}

export function createExampleWebSocketClient(params?: { url?: string }): ExampleClient {
  const base = params?.url ?? FALLBACK_ORIGIN;
  const wsUrl = base.replace(/^http/, "ws") + "/api/orpc/ws";
  const link = new WebSocketRPCLink({ websocket: new WebSocket(wsUrl, ["orpc"]) });
  return createORPCClient(link);
}
